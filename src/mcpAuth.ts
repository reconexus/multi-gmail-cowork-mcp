import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { RequestHandler } from 'express';
import { loadConfig } from './config.js';

/**
 * Gates /mcp with OAuth 2.1 access tokens issued by this deployment. The
 * challenge points remote MCP clients at RFC 9728 protected-resource metadata.
 */
export function mcpOAuthAuth(verifier: OAuthTokenVerifier): RequestHandler {
  const resourceUrl = new URL(`${loadConfig().publicBaseUrl}/mcp`);
  return requireBearerAuth({
    verifier,
    requiredScopes: ['mcp:tools'],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
  });
}
