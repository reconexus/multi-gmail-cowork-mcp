import type { RequestHandler } from 'express';
import { loadConfig } from './config.js';
import { safeEqual } from './safeCompare.js';

/**
 * Protects the admin (account management) routes with HTTP Basic Auth against a
 * dedicated admin password — deliberately separate from the MCP OAuth credentials, so a
 * leaked Claude connector header can search email but cannot add or remove
 * connected accounts.
 */
export const requireAdminAuth: RequestHandler = (req, res, next) => {
  const config = loadConfig();
  const header = req.headers.authorization;

  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex !== -1) {
      const username = decoded.slice(0, separatorIndex);
      const password = decoded.slice(separatorIndex + 1);
      if (safeEqual(username, config.adminUsername) && safeEqual(password, config.adminPassword)) {
        next();
        return;
      }
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="multi-gmail-mcp admin", charset="UTF-8"');
  res.status(401).send('Authentication required.');
};

/**
 * CSRF defense for the state-changing admin POST routes (connect/disconnect).
 *
 * HTTP Basic Auth credentials are cached by the browser per-origin and reattached
 * automatically to any request to that origin — including a plain HTML form POST
 * submitted from a completely different site the admin merely visits. That request
 * is not blocked by the Same-Origin Policy (a same-origin-policy violation only
 * blocks reading the *response*, not sending a simple form POST) and carries no
 * cookie, so a SameSite cookie attribute would not help here either. Because this
 * app deliberately has no session/cookie of its own to attach a synchronizer CSRF
 * token to, the standard lightweight alternative is used instead: reject any
 * state-changing request whose Origin (or, failing that, Referer) header does not
 * match this deployment's own origin. Real browsers reliably send at least one of
 * these on a same-origin form submission; a cross-site one will not match.
 */
export const requireSameOrigin: RequestHandler = (req, res, next) => {
  const expectedOrigin = new URL(loadConfig().publicBaseUrl).origin;
  const origin = req.headers.origin;
  const referer = req.headers.referer;

  let actualOrigin: string | undefined = origin;
  if (!actualOrigin && referer) {
    try {
      actualOrigin = new URL(referer).origin;
    } catch {
      actualOrigin = undefined;
    }
  }

  if (actualOrigin === expectedOrigin) {
    next();
    return;
  }

  res.status(403).send('Cross-origin request rejected.');
};
