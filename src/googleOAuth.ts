import { randomBytes, createHash } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { loadConfig, GMAIL_READONLY_SCOPE } from './config.js';

export interface Pkce {
  codeVerifier: string;
  codeChallenge: string;
}

/** RFC 7636 PKCE pair, S256. Used on the Gmail account-linking flow for defense in depth. */
export function generatePkce(): Pkce {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

function redirectUri(): string {
  return `${loadConfig().publicBaseUrl}/oauth/google/callback`;
}

function newClient(): OAuth2Client {
  const config = loadConfig();
  return new OAuth2Client({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: redirectUri(),
  });
}

export function buildAuthorizationUrl(state: string, pkce: Pkce): string {
  const client = newClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent select_account',
    scope: [GMAIL_READONLY_SCOPE],
    include_granted_scopes: false,
    state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256' as never,
  });
}

export async function exchangeCodeForRefreshToken(
  code: string,
  codeVerifier: string,
): Promise<{ refreshToken: string; scopes: string[] }> {
  const client = newClient();
  const { tokens } = await client.getToken({ code, codeVerifier });
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. This usually means the account was already ' +
        'authorized without prompt=consent, or the OAuth client is misconfigured. Try again.',
    );
  }
  const scopes = (tokens.scope ?? '').split(' ').filter(Boolean);
  return { refreshToken: tokens.refresh_token, scopes };
}

/** A ready-to-use client for calling Gmail on behalf of one connected account. */
export function clientForRefreshToken(refreshToken: string): OAuth2Client {
  const config = loadConfig();
  const client = new OAuth2Client({ clientId: config.googleClientId, clientSecret: config.googleClientSecret });
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

/** Calls Gmail's profile endpoint to get the *actual* authenticated address, never trust client input for this. */
export async function fetchAuthenticatedEmail(client: OAuth2Client): Promise<string> {
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Failed to obtain an access token while verifying account identity.');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to verify Gmail identity (HTTP ${res.status}).`);
  }
  const body = (await res.json()) as { emailAddress?: string };
  if (!body.emailAddress) throw new Error('Gmail profile response did not include an email address.');
  return body.emailAddress;
}

/** Best-effort revocation with Google when an account is disconnected. Never throws. */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  try {
    const client = newClient();
    await client.revokeToken(refreshToken);
  } catch {
    // Best-effort only — the local record is removed regardless of whether Google's
    // revoke endpoint succeeds (e.g. token may already be invalid).
  }
}

/** True when a Google API error indicates the stored grant is no longer usable. */
export function isReauthRequiredError(err: unknown): boolean {
  const message = String((err as { message?: string })?.message ?? err ?? '').toLowerCase();
  const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
  return (
    status === 401 ||
    status === 400 ||
    message.includes('invalid_grant') ||
    message.includes('invalid_token') ||
    message.includes('unauthorized')
  );
}
