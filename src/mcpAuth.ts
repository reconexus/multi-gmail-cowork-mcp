import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { RequestHandler } from 'express';
import { loadConfig } from './config.js';
import { safeEqual } from './safeCompare.js';

/**
 * Gates the /mcp endpoint with a single, per-deployment, high-entropy bearer token
 * rather than a full OAuth 2.1 authorization-server implementation.
 *
 * Rationale (see README/SECURITY.md for the full writeup): the MCP Authorization
 * spec makes authorization OPTIONAL for MCP servers; when a server does implement
 * it, the spec calls for acting as an OAuth 2.1 resource server delegating to a
 * separate authorization server. For a single-operator, single-trusted-client
 * deployment like this one, that machinery adds a meaningful amount of code and
 * attack surface (client registration, PKCE verification, token issuance/refresh,
 * protected-resource metadata) without a corresponding security benefit — there is
 * exactly one legitimate client per deployment, matching this connector to the
 * operator's own Claude account. Anthropic's custom-connector "request headers"
 * feature is a supported, first-class mechanism for exactly this shape of
 * deployment. This token is generated at setup time, stored only in Secret
 * Manager, and never appears in source control, logs, or MCP responses.
 */
class StaticTokenVerifier implements OAuthTokenVerifier {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const config = loadConfig();
    if (!safeEqual(token, config.mcpBearerToken)) {
      throw new Error('Invalid bearer token');
    }
    return {
      token,
      clientId: 'cowork-operator',
      scopes: ['gmail:read'],
      // The SDK's requireBearerAuth requires an expiry on every AuthInfo. This token
      // is verified fresh on every single request (it's a constant-time compare
      // against the deployment's static secret, not a cached decision), so a
      // rolling near-term expiry satisfies that structural requirement without
      // implying any real token lifecycle — the actual security boundary is the
      // secret comparison above, not this timestamp.
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }
}

export function mcpBearerAuth(): RequestHandler {
  return requireBearerAuth({ verifier: new StaticTokenVerifier() });
}
