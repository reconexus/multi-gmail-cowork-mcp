import { Router } from 'express';
import { getAccountStore } from './accountStore.js';
import { clientForRefreshToken, exchangeCodeForRefreshToken, fetchAuthenticatedEmail } from './googleOAuth.js';
import { escapeHtml, pageShell } from './html.js';
import { log } from './logger.js';
import { verifyState } from './oauthState.js';
import type { AccountRecord } from './types.js';

function infoPage(title: string, message: string, isError: boolean): string {
  return pageShell(
    title,
    `<h1>${escapeHtml(title)}</h1>
<p class="${isError ? 'err' : 'msg'}">${escapeHtml(message)}</p>
<p><a href="/admin">Back to admin page</a></p>`,
  );
}

/**
 * Handles Google's redirect back after the user authorizes (or denies) Gmail
 * read-only access for one alias. This is a distinct OAuth flow from Claude's
 * connection to this server's /mcp endpoint — see README "Two OAuth flows".
 */
export function createOAuthCallbackRouter(): Router {
  const router = Router();

  router.get('/google/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (typeof error === 'string') {
      res.type('html').send(infoPage('Authorization declined', `Google reported: ${error}`, true));
      return;
    }
    if (typeof code !== 'string' || typeof state !== 'string' || !code || !state) {
      res.status(400).type('html').send(infoPage('Invalid request', 'Missing code or state parameter.', true));
      return;
    }

    let payload: ReturnType<typeof verifyState>;
    try {
      payload = verifyState(state);
    } catch (err) {
      log.error('oauth_callback_invalid_state', { message: (err as Error).message });
      res
        .status(400)
        .type('html')
        .send(infoPage('Link expired or invalid', 'Go back to the admin page and try connecting the account again.', true));
      return;
    }

    try {
      const { refreshToken, scopes } = await exchangeCodeForRefreshToken(code, payload.codeVerifier);
      const client = clientForRefreshToken(refreshToken);
      const email = await fetchAuthenticatedEmail(client);

      const record: AccountRecord = {
        alias: payload.alias,
        email,
        refreshToken,
        scopes,
        connectedAt: new Date().toISOString(),
      };
      await getAccountStore().upsert(record);
      log.info('account_connected', { alias: payload.alias });

      res.type('html').send(infoPage('Account connected', `"${payload.alias}" is now connected as ${email}.`, false));
    } catch (err) {
      log.error('oauth_callback_exchange_failed', { alias: payload.alias, message: (err as Error).message });
      res
        .status(502)
        .type('html')
        .send(infoPage('Connection failed', 'Failed to complete Google authorization. Please try again.', true));
    }
  });

  return router;
}
