function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : fallback;
}

export type TokenStoreKind = 'secret-manager' | 'file';

export interface Config {
  port: number;
  publicBaseUrl: string;
  gcpProjectId: string;
  googleClientId: string;
  googleClientSecret: string;
  adminUsername: string;
  adminPassword: string;
  oauthStateSecret: string;
  mcpOAuthStateSecretName: string;
  tokenStore: TokenStoreKind;
  accountsSecretName: string;
  enableWriteTools: boolean;
  logLevel: 'info' | 'debug';
}

let cached: Config | undefined;

/**
 * Loaded once at process start and reused. Throws loudly and immediately if a
 * required secret is missing, rather than letting the server start half-configured.
 */
export function loadConfig(): Config {
  if (cached) return cached;

  const tokenStore = optional('TOKEN_STORE', 'secret-manager') as TokenStoreKind;
  if (tokenStore !== 'secret-manager' && tokenStore !== 'file') {
    throw new Error(`TOKEN_STORE must be "secret-manager" or "file", got: ${tokenStore}`);
  }
  if (tokenStore === 'file' && process.env.NODE_ENV === 'production') {
    throw new Error('TOKEN_STORE=file is not allowed when NODE_ENV=production. Use secret-manager.');
  }

  const logLevel = optional('LOG_LEVEL', 'info');
  if (logLevel !== 'info' && logLevel !== 'debug') {
    throw new Error(`LOG_LEVEL must be "info" or "debug", got: ${logLevel}`);
  }

  cached = {
    port: Number(optional('PORT', '8080')),
    publicBaseUrl: required('PUBLIC_BASE_URL').replace(/\/+$/, ''),
    gcpProjectId: tokenStore === 'secret-manager' ? required('GCP_PROJECT_ID') : optional('GCP_PROJECT_ID', ''),
    googleClientId: required('GOOGLE_CLIENT_ID'),
    googleClientSecret: required('GOOGLE_CLIENT_SECRET'),
    adminUsername: optional('ADMIN_USERNAME', 'admin'),
    adminPassword: required('ADMIN_PASSWORD'),
    oauthStateSecret: required('OAUTH_STATE_SECRET'),
    mcpOAuthStateSecretName: optional('MCP_OAUTH_STATE_SECRET_NAME', 'mcp-oauth-state'),
    tokenStore,
    accountsSecretName: optional('ACCOUNTS_SECRET_NAME', 'gmail-mcp-accounts'),
    enableWriteTools: optional('ENABLE_WRITE_TOOLS', 'false').toLowerCase() === 'true',
    logLevel,
  };

  return cached;
}

export const ALIAS_PATTERN = /^[a-z0-9_-]{1,32}$/;

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
