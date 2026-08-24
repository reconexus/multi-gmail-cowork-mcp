import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { RequestHandler } from 'express';
import { mcpResourceUrl } from './mcpOAuth.js';

/**
 * Gates /mcp with OAuth 2.1 access tokens issued by this deployment. The
 * challenge points remote MCP clients at RFC 9728 protected-resource metadata.
 */
export function mcpOAuthAuth(verifier: OAuthTokenVerifier, resourceUrl = mcpResourceUrl('/mcp')): RequestHandler {
  return requireBearerAuth({
    verifier,
    requiredScopes: ['mcp:tools'],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
  });
}
