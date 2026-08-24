import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Response } from 'express';
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { loadConfig } from './config.js';
import { escapeHtml, pageShell } from './html.js';
import { safeEqual } from './safeCompare.js';

export const MCP_SCOPE = 'mcp:tools';
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
const PENDING_REQUEST_TTL_SECONDS = 10 * 60;

interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

interface RefreshTokenRecord {
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

interface OAuthState {
  clients: OAuthClientInformationFull[];
  authorizationCodes: Record<string, AuthorizationCodeRecord>;
  refreshTokens: Record<string, RefreshTokenRecord>;
}

interface SignedPendingRequest {
  type: 'pending';
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

interface SignedAccessToken {
  type: 'access';
  clientId: string;
  scopes: string[];
  resource: string;
  issuedAt: number;
  expiresAt: number;
  tokenId: string;
}

interface SignedRefreshToken {
  type: 'refresh';
  clientId: string;
  scopes: string[];
  resource: string;
  issuedAt: number;
  expiresAt: number;
  tokenId: string;
}

type SignedPayload = SignedPendingRequest | SignedAccessToken | SignedRefreshToken;

function emptyState(): OAuthState {
  return { clients: [], authorizationCodes: {}, refreshTokens: {} };
}

function parseState(value: string): OAuthState {
  if (!value.trim()) return emptyState();
  const parsed = JSON.parse(value) as Partial<OAuthState>;
  if (!Array.isArray(parsed.clients) || !parsed.authorizationCodes || !parsed.refreshTokens) {
    throw new Error('MCP OAuth state secret is malformed.');
  }
  return {
    clients: parsed.clients,
    authorizationCodes: parsed.authorizationCodes,
    refreshTokens: parsed.refreshTokens,
  };
}

/**
 * Persistent per-deployment OAuth state. Client registrations and one-time
 * grants must survive Cloud Run instance changes, so they live in their own
 * Secret Manager secret (never in the Gmail account store).
 */
class OAuthStateStore {
  private readonly secretPath: string;
  private readonly filePath: string;
  private readonly client = new SecretManagerServiceClient();
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor() {
    const config = loadConfig();
    this.secretPath = `projects/${config.gcpProjectId}/secrets/${config.mcpOAuthStateSecretName}`;
    this.filePath = join(process.cwd(), '.local', 'mcp-oauth-state.json');
  }

  private async read(): Promise<{ state: OAuthState; versionName?: string }> {
    const config = loadConfig();
    if (config.tokenStore === 'file') {
      if (!existsSync(this.filePath)) return { state: emptyState() };
      return { state: parseState(readFileSync(this.filePath, 'utf8')) };
    }

    try {
      const [version] = await this.client.accessSecretVersion({ name: `${this.secretPath}/versions/latest` });
      const bytes = version.payload?.data;
      const value = bytes ? (typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8')) : '';
      return { state: parseState(value), versionName: version.name ?? undefined };
    } catch (err) {
      if ((err as { code?: number }).code === 5) return { state: emptyState() };
      throw err;
    }
  }

  private async persist(state: OAuthState, basedOnVersion?: string): Promise<void> {
    const config = loadConfig();
    const payload = JSON.stringify(state);
    if (config.tokenStore === 'file') {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, payload, 'utf8');
      return;
    }

    const [newVersion] = await this.client.addSecretVersion({
      parent: this.secretPath,
      payload: { data: Buffer.from(payload, 'utf8') },
    });
    if (basedOnVersion && basedOnVersion !== newVersion.name) {
      try {
        await this.client.destroySecretVersion({ name: basedOnVersion });
      } catch {
        // Cleanup is best-effort; the new version is already authoritative.
      }
    }
  }

  async readState(): Promise<OAuthState> {
    return (await this.read()).state;
  }

  async update<T>(mutate: (state: OAuthState) => { state: OAuthState; result: T }): Promise<T> {
    const operation = this.writeQueue.then(async () => {
      const current = await this.read();
      const next = mutate(current.state);
      await this.persist(next.state, current.versionName);
      return next.result;
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function signPayload(payload: SignedPayload): string {
  const body = base64Url(JSON.stringify(payload));
  const signature = createHmac('sha256', loadConfig().oauthStateSecret).update(body).digest();
  return `${body}.${base64Url(signature)}`;
}

function decodePayload(token: string): SignedPayload | undefined {
  const [body, encodedSignature] = token.split('.');
  if (!body || !encodedSignature) return undefined;
  const expected = createHmac('sha256', loadConfig().oauthStateSecret).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(encodedSignature, 'base64url');
  } catch {
    return undefined;
  }
  if (!safeEqual(actual.toString('base64url'), expected.toString('base64url'))) return undefined;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedPayload;
  } catch {
    return undefined;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function expectedResource(): string {
  return `${loadConfig().publicBaseUrl}/mcp`;
}

function validateResource(resource: URL | undefined): string {
  const expected = expectedResource();
  if (resource && resource.toString().replace(/\/$/, '') !== expected.replace(/\/$/, '')) {
    throw new InvalidTargetError('The requested resource is not this MCP server.');
  }
  return expected;
}

function validateScopes(scopes: string[]): string[] {
  const requested = scopes.length > 0 ? scopes : [MCP_SCOPE];
  if (requested.some((scope) => scope !== MCP_SCOPE)) {
    throw new InvalidScopeError('Only the mcp:tools scope is supported.');
  }
  return [MCP_SCOPE];
}

function createTokens(clientId: string, scopes: string[], resource: string): {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  refreshRecord: RefreshTokenRecord;
} {
  const issuedAt = Math.floor(Date.now() / 1000);
  const accessExpiresAt = issuedAt + ACCESS_TOKEN_TTL_SECONDS;
  const refreshExpiresAt = issuedAt + REFRESH_TOKEN_TTL_SECONDS;
  const accessToken = signPayload({
    type: 'access',
    clientId,
    scopes,
    resource,
    issuedAt,
    expiresAt: accessExpiresAt,
    tokenId: randomBytes(16).toString('hex'),
  });
  const refreshToken = signPayload({
    type: 'refresh',
    clientId,
    scopes,
    resource,
    issuedAt,
    expiresAt: refreshExpiresAt,
    tokenId: randomBytes(16).toString('hex'),
  });
  return {
    accessToken,
    refreshToken,
    accessExpiresAt,
    refreshExpiresAt,
    refreshRecord: { clientId, scopes, resource, expiresAt: refreshExpiresAt },
  };
}

function tokenResponse(tokens: ReturnType<typeof createTokens>): OAuthTokens {
  return {
    access_token: tokens.accessToken,
    token_type: 'bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: tokens.refreshToken,
    scope: tokens.refreshRecord.scopes.join(' '),
  };
}

function renderConsentPage(pendingToken: string, clientName: string): string {
  const body = `
<h1>Authorize ${escapeHtml(clientName)}</h1>
<p>This will let Claude use the read-only Gmail tools exposed by this private deployment.</p>
<form method="post" action="/authorize/consent">
  <input type="hidden" name="request" value="${escapeHtml(pendingToken)}">
  <label>Admin username:
    <input type="text" name="username" autocomplete="username" required autofocus>
  </label>
  <label>Admin password:
    <input type="password" name="password" autocomplete="current-password" required>
  </label>
  <button type="submit" name="decision" value="approve">Authorize</button>
  <button type="submit" name="decision" value="deny">Cancel</button>
</form>
<p><small>This is the same admin credential used for the deployment's /admin page. It is sent only over HTTPS and is never shown to Claude or stored by this page.</small></p>`;
  return pageShell('Authorize MCP access', body);
}

export class MultiGmailOAuthProvider implements OAuthServerProvider {
  private readonly stateStore = new OAuthStateStore();

  get clientsStore(): OAuthRegisteredClientsStore {
    return this;
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const state = await this.stateStore.readState();
    return state.clients.find((client) => client.client_id === clientId);
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    if (!client.client_id) throw new Error('OAuth client ID was not generated.');
    return this.stateStore.update((state) => ({
      state: {
        ...state,
        clients: [...state.clients.filter((existing) => existing.client_id !== client.client_id), client].slice(-100),
      },
      result: client,
    }));
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const scopes = validateScopes(params.scopes ?? []);
    const resource = validateResource(params.resource);
    const pendingToken = signPayload({
      type: 'pending',
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes,
      resource,
      expiresAt: Math.floor(Date.now() / 1000) + PENDING_REQUEST_TTL_SECONDS,
    });
    res.type('html').send(renderConsentPage(pendingToken, client.client_name || 'Claude'));
  }

  async completeAuthorization(
    pendingToken: string,
    username: string,
    password: string,
    decision: string,
  ): Promise<{ redirectUrl?: string; error?: string }> {
    const pending = decodePayload(pendingToken);
    if (!pending || pending.type !== 'pending' || pending.expiresAt < Math.floor(Date.now() / 1000)) {
      return { error: 'This authorization request expired. Start the connector connection again.' };
    }
    if (decision !== 'approve') {
      const redirect = new URL(pending.redirectUri);
      redirect.searchParams.set('error', 'access_denied');
      if (pending.state) redirect.searchParams.set('state', pending.state);
      return { redirectUrl: redirect.href };
    }
    const config = loadConfig();
    if (!safeEqual(username, config.adminUsername) || !safeEqual(password, config.adminPassword)) {
      return { error: 'Invalid admin credentials.' };
    }
    const client = await this.getClient(pending.clientId);
    if (!client || !client.redirect_uris.includes(pending.redirectUri)) {
      return { error: 'The OAuth client is no longer registered.' };
    }
    const code = randomBytes(32).toString('base64url');
    await this.stateStore.update((state) => ({
      state: {
        ...state,
        authorizationCodes: {
          ...state.authorizationCodes,
          [hashToken(code)]: {
            clientId: pending.clientId,
            redirectUri: pending.redirectUri,
            codeChallenge: pending.codeChallenge,
            scopes: pending.scopes,
            resource: pending.resource,
            expiresAt: Math.floor(Date.now() / 1000) + AUTHORIZATION_CODE_TTL_SECONDS,
          },
        },
      },
      result: undefined,
    }));
    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set('code', code);
    if (pending.state) redirect.searchParams.set('state', pending.state);
    return { redirectUrl: redirect.href };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const record = (await this.stateStore.readState()).authorizationCodes[hashToken(authorizationCode)];
    if (!record || record.expiresAt < Math.floor(Date.now() / 1000) || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code.');
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const codeKey = hashToken(authorizationCode);
    const resourceValue = validateResource(resource);
    return this.stateStore.update((state) => {
      const record = state.authorizationCodes[codeKey];
      if (!record || record.expiresAt < Math.floor(Date.now() / 1000)) {
        throw new InvalidGrantError('Invalid or expired authorization code.');
      }
      if (record.clientId !== client.client_id || (redirectUri && redirectUri !== record.redirectUri)) {
        throw new InvalidGrantError('Authorization code was not issued to this client.');
      }
      if (record.resource !== resourceValue) {
        throw new InvalidTargetError('The requested resource is not this MCP server.');
      }
      const issued = createTokens(client.client_id, record.scopes, resourceValue);
      const refreshKey = hashToken(issued.refreshToken);
      const nextCodes = { ...state.authorizationCodes };
      delete nextCodes[codeKey];
      return {
        state: {
          ...state,
          authorizationCodes: nextCodes,
          refreshTokens: { ...state.refreshTokens, [refreshKey]: issued.refreshRecord },
        },
        result: tokenResponse(issued),
      };
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const decoded = decodePayload(refreshToken);
    const resourceValue = validateResource(resource);
    if (!decoded || decoded.type !== 'refresh' || decoded.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidGrantError('Invalid or expired refresh token.');
    }
    const key = hashToken(refreshToken);
    return this.stateStore.update((state) => {
      const record = state.refreshTokens[key];
      if (!record || record.clientId !== client.client_id || record.resource !== resourceValue) {
        throw new InvalidGrantError('Invalid or revoked refresh token.');
      }
      const nextScopes = validateScopes(scopes ?? record.scopes);
      const issued = createTokens(client.client_id, nextScopes, resourceValue);
      const refreshTokens = { ...state.refreshTokens };
      delete refreshTokens[key];
      refreshTokens[hashToken(issued.refreshToken)] = issued.refreshRecord;
      return { state: { ...state, refreshTokens }, result: tokenResponse(issued) };
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const decoded = decodePayload(token);
    if (!decoded || decoded.type !== 'access' || decoded.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new Error('Invalid or expired access token.');
    }
    const resource = validateResource(new URL(decoded.resource));
    if (decoded.resource !== resource || !decoded.scopes.includes(MCP_SCOPE)) {
      throw new Error('Access token is not valid for this MCP server.');
    }
    return {
      token,
      clientId: decoded.clientId,
      scopes: decoded.scopes,
      expiresAt: decoded.expiresAt,
      resource: new URL(resource),
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const token = request.token;
    const decoded = decodePayload(token);
    if (!decoded || decoded.type !== 'refresh') return;
    await this.stateStore.update((state) => {
      const refreshTokens = { ...state.refreshTokens };
      delete refreshTokens[hashToken(token)];
      return { state: { ...state, refreshTokens }, result: undefined };
    });
  }
}

export function createMcpOAuthProvider(): MultiGmailOAuthProvider {
  return new MultiGmailOAuthProvider();
}
