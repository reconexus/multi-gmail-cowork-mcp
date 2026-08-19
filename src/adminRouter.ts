import express, { Router } from 'express';
import { getAccountStore } from './accountStore.js';
import { requireAdminAuth, requireSameOrigin } from './adminAuth.js';
import { ALIAS_PATTERN } from './config.js';
import { buildAuthorizationUrl, generatePkce, revokeRefreshToken } from './googleOAuth.js';
import { escapeHtml, pageShell } from './html.js';
import { log } from './logger.js';
import { createState } from './oauthState.js';
import { toSummary, type AccountSummary } from './types.js';

function renderAdminPage(accounts: AccountSummary[], message?: string): string {
  const rows = accounts
    .map(
      (a) => `<tr>
  <td>${escapeHtml(a.alias)}</td>
  <td>${escapeHtml(a.email)}</td>
  <td>Connected</td>
  <td>
    <form class="inline" method="post" action="/admin/accounts/${encodeURIComponent(a.alias)}/disconnect">
      <button type="submit">Disconnect</button>
    </form>
  </td>
</tr>`,
    )
    .join('\n');

  const body = `
<h1>Multi-Gmail MCP — Admin</h1>
${message ? `<p class="msg">${escapeHtml(message)}</p>` : ''}
<h2>Connected accounts</h2>
<table>
  <thead><tr><th>Alias</th><th>Email</th><th>Status</th><th></th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4"><em>No accounts connected yet.</em></td></tr>'}</tbody>
</table>

<h2>Add Gmail account</h2>
<form method="post" action="/admin/accounts/start">
  <label>Alias (e.g. "work", "personal"):
    <input type="text" name="alias" pattern="[a-z0-9_-]{1,32}" maxlength="32" required autofocus>
  </label>
  <button type="submit">Connect account</button>
</form>
<p><small>Connecting opens Google's sign-in and consent screen. You choose the Google account there; this app
only ever sees the address Google confirms after you approve read-only Gmail access.</small></p>
`;
  return pageShell('Multi-Gmail MCP — Admin', body);
}

export function createAdminRouter(): Router {
  const router = Router();
  router.use(requireAdminAuth);
  router.use(express.urlencoded({ extended: false }));

  router.get('/', async (req, res) => {
    const accounts = await getAccountStore().list();
    const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
    res.type('html').send(renderAdminPage(accounts.map(toSummary), msg));
  });

  router.post('/accounts/start', requireSameOrigin, (req, res) => {
    const alias = String((req.body as { alias?: string }).alias ?? '').trim();
    if (!ALIAS_PATTERN.test(alias)) {
      res.redirect(
        '/admin?msg=' +
          encodeURIComponent('Invalid alias. Use lowercase letters, digits, "-" or "_", max 32 characters.'),
      );
      return;
    }
    const pkce = generatePkce();
    const state = createState(alias, pkce.codeVerifier);
    res.redirect(buildAuthorizationUrl(state, pkce));
  });

  router.post('/accounts/:alias/disconnect', requireSameOrigin, async (req, res) => {
    const alias = req.params.alias ?? '';
    if (!ALIAS_PATTERN.test(alias)) {
      res.redirect('/admin?msg=' + encodeURIComponent('Invalid alias.'));
      return;
    }
    const store = getAccountStore();
    const existing = await store.get(alias);
    if (existing) {
      await revokeRefreshToken(existing.refreshToken);
      await store.remove(alias);
      log.info('account_disconnected', { alias });
    }
    res.redirect('/admin?msg=' + encodeURIComponent(`Disconnected "${alias}".`));
  });

  return router;
}
