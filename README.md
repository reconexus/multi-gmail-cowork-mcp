# multi-gmail-cowork-mcp

[![Open in Google Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://console.cloud.google.com/cloudshell/open?git_repo=https://github.com/YOUR-OWNER/multi-gmail-cowork-mcp&shellonly=true)

The button uses the repository URL that will be published after the final review. If you
are running an unpublished fork, open Cloud Shell and clone that fork first.

A small, self-hosted [MCP](https://modelcontextprotocol.io) server that lets **one Claude
custom connector** search and read **multiple, independently-authenticated Gmail accounts**
— read-only. Built to be deployed by anyone into their own Google Cloud project, with zero
shared infrastructure and zero code changes required per deployment.

```
Claude Cowork
      |
      v
Your private Multi-Gmail MCP  (your own Cloud Run project)
      |
      +-- Gmail account: "personal"
      +-- Gmail account: "work"
      +-- Gmail account: "billing"
      +-- ...more, added any time via the admin page
```

Ask Claude things like:

- "Search my work Gmail for emails from David."
- "Search all connected Gmail accounts for 'invoice 4831'."
- "Read the latest email from ACH Works, whichever account received it."
- "Which of my Gmail accounts received an email from John yesterday?"

Every result is explicitly attributed to the account alias and email address it came from.
If you ask for an account that isn't connected, or whose authorization has expired, you get
a clear error — this server never silently substitutes a different account.

## What this is not

Gmail only. No Calendar, Drive, Docs, Sheets, or Contacts. No sending/drafting by default
(see "Write access" below). No shared backend, no central account, no telemetry.

## Privacy model — who can see your email

```
Google  <->  Your Google Cloud deployment  <->  Claude / Anthropic
```

- **You** deploy this into **your own** Google Cloud project, using **your own** Google
  OAuth client and **your own** Cloud Run service.
- **Google** issues/can revoke the OAuth grants; it sees ordinary OAuth traffic.
- **Your deployment** is the only place Gmail refresh tokens are ever stored.
- **Claude/Anthropic** sees whatever the tools return when Claude calls them (same as any
  other MCP tool) — nothing more, nothing when you're not using it.
- **The author of this repository sees none of your email**, ever. There is no shared
  server. Your cousin's deployment and your deployment have nothing in common except the
  source code.

Read [SECURITY.md](SECURITY.md) for the full trust-boundary and design-rationale writeup —
including exactly why authentication is implemented the way it is, and this project's known
limitations. This README does not repeat that reasoning.

## Architecture at a glance

- **Language/runtime:** TypeScript on Node.js 20+, using the official
  `@modelcontextprotocol/sdk` and Google's `google-auth-library`.
- **Transport:** Streamable HTTP (the current MCP-recommended remote transport), stateless
  — every request is handled independently, so it scales cleanly on Cloud Run with no
  session affinity required.
- **Claude <-> server auth:** MCP OAuth 2.1 authorization-code flow with PKCE/S256,
  Dynamic Client Registration, short-lived access tokens, rotating refresh tokens, and
  deployment-local authorization state in Secret Manager.
- **Server <-> Google auth:** standard OAuth 2.0 with PKCE, one grant per connected Gmail
  account, `gmail.readonly` scope.
- **Account storage:** one Google Secret Manager secret holding a small JSON array
  (alias, email, refresh token). No database.
- **Admin UI:** a few unstyled HTML pages behind HTTP Basic Auth — just enough to connect
  or disconnect accounts.

## Prerequisites

- A Google account and a Google Cloud project with billing enabled (the bootstrap prints the
  exact billing page if billing is not linked).
- A Claude plan that supports custom connectors (for connecting to Cowork/claude.ai).
- Nothing else is required for a deployment: Google Cloud Shell already includes `gcloud`,
  `curl`, `openssl`, and `jq`.

## One-command Cloud Shell setup (recommended)

1. Open this repository in Google Cloud Shell using the button above (or use **Open in Cloud
   Shell** on GitHub).
2. Authenticate if Cloud Shell asks, then run:

```bash
./scripts/bootstrap.sh
```

The script asks you to select a project (or creates one), checks billing, enables the required
APIs, creates the dedicated Cloud Run runtime service account, assigns only the Secret Manager
roles it needs, creates all secrets, deploys Cloud Run, and prints PASS/FAIL checks. It is safe
to rerun: existing secrets, account records, OAuth credentials, and Cloud Run services are
preserved.

The script never prints a password, OAuth client secret, refresh token, account-store JSON, or
MCP OAuth token. Secret values are written as exact bytes (no trailing-newline credential bug).
Use `./scripts/bootstrap.sh --check` for a read-only Cloud Shell prerequisite check.

### The one unavoidable Google browser step

Google does not provide a safe, supported API/CLI operation for creating a general-purpose web
OAuth client. When the bootstrap asks, open the Google Auth Platform page it prints and do the
following:

- Configure the app as **External**, add the scope
  `https://www.googleapis.com/auth/gmail.readonly`, and add the Gmail addresses you will use as
  test users.
- Create an OAuth client with application type **Web application**.
- Enter the exact callback URI printed by the script:
  `https://<your-cloud-run-host>/oauth/google/callback`.
- Paste the resulting Client ID and Client Secret into the hidden prompts in Cloud Shell.

If Google shows an unverified-app warning, that is expected for a personal deployment. Publish
the consent screen to **In production** if you want refresh tokens to remain valid beyond the
Testing-mode seven-day limit; verification is not required for a personal/small deployment.

At the end, bootstrap prints the Admin URL, exact Google OAuth callback URL, MCP URL, and the
next human action. Claude authenticates to the MCP endpoint through its supported OAuth flow;
there is no static connector header to copy or put in a URL.

## Connect Gmail accounts

1. Open the printed Admin URL and sign in with username `admin` and the admin password you set
   or retrieve from your own Secret Manager. The password is intentionally never displayed by
   the bootstrap.
2. Enter a short alias such as `personal` or `work`, click **Add Gmail Account**, and complete
   Google authorization. The authorization URL requests `consent select_account`, so Google
   shows the account chooser every time. The address displayed after callback is the address
   Google actually authorized; it is not taken from the alias field.
3. Repeat for as many Gmail accounts as desired. Each alias is independent and all results are
   attributed to both alias and verified Gmail address.

## Connect Claude Cowork

In Claude, open **Customize -> Connectors -> Add custom connector** and enter exactly:

1. **Connector name:** `Multi Gmail`
2. **Remote MCP URL:** the printed URL ending in `/mcp`
3. **OAuth Client ID:** leave blank (the server supports Dynamic Client Registration)
4. **OAuth Client Secret:** leave blank

Click **Add**, then **Connect**. Claude discovers the MCP authorization metadata, registers
itself, and opens the deployment's **Authorize MCP access** page. Sign in there with username
`admin` and the admin password stored in your own `admin-password` Secret Manager secret, then
approve. Claude redirects through its callback at
`https://claude.ai/api/mcp/auth_callback`, stores the OAuth tokens, and reconnects. Do not
enter the Gmail OAuth client ID or secret in Claude — those belong only to Google's Gmail setup.

After the connector is connected, ask Claude to call `list_accounts`, then run an
alias-specific search for each account and `search_all_accounts` to verify attribution.

## Local development (optional)

For source development only, install Node.js 20+, run `npm install`, copy `.env.example` to
`.env`, set `TOKEN_STORE=file`, and use `npm run dev`. Local Gmail OAuth requires a separate
OAuth client callback such as `http://localhost:8080/oauth/google/callback`; do not reuse or
commit production secrets. Windows users can use `scripts/setup.ps1` and `scripts/deploy.ps1`
instead of the Cloud Shell bootstrap.

## Updating / revoking accounts

Go back to `/admin` and click **Disconnect** next to an account. This revokes the grant
with Google (best-effort) and removes it from the credential store immediately — Claude
will get a clear "not connected" error if it's asked for that alias afterward, never a
silent fallback to a different account.

To reconnect the same alias (e.g. after revoking access on Google's side, or to refresh a
broken grant), just click **Connect account** again with the same alias — it overwrites
the old record.

## Write access (disabled by default)

Version 1 is read-only. `ENABLE_WRITE_TOOLS=false` by default; no write tools or write
scopes are requested. The codebase is structured so that adding narrowly-scoped write
tools later (e.g. draft creation with `gmail.compose`) doesn't require rearchitecting
account storage, auth, or the multi-account model — but no write capability exists yet.

## How to delete everything

- **Remove Gmail access:** disconnect each account from `/admin`, or revoke access
  directly at <https://myaccount.google.com/permissions>.
- **Tear down the deployment:**
  ```powershell
  gcloud run services delete multi-gmail-mcp --region us-central1
  gcloud secrets delete mcp-bearer-token mcp-oauth-state admin-password oauth-state-secret google-client-id google-client-secret gmail-mcp-accounts
  gcloud iam service-accounts delete multi-gmail-mcp-run@YOUR_PROJECT_ID.iam.gserviceaccount.com
  ```
- **Delete the OAuth client:** Cloud Console -> APIs & Services -> Credentials -> delete
  the OAuth client ID, and optionally delete the OAuth consent screen configuration.
- Or simplest: delete the whole Google Cloud project.

## Troubleshooting

- **"Account needs to be reconnected" errors:** the stored refresh token was rejected by
  Google (revoked, expired, or the consent screen is stuck in "Testing" — see below).
  Reconnect it from `/admin`.
- **Refresh tokens keep dying after ~7 days:** your OAuth consent screen is still in
  "Testing" publishing status. Publish it to "In production" (see step 3) — it can stay
  unverified, that's fine for personal use.
- **Claude can't reach the connector / connection fails silently:** confirm the service URL
  resolves over plain HTTPS with no redirect to a different host, then open the MCP URL ending
  in `/mcp` in Claude and click **Connect** again. The server must return OAuth metadata and a
  401 challenge when called without an access token; no static request header is required.
- **`gcloud run deploy` fails on APIs not enabled:** re-run `scripts/setup.ps1`, or run
  `gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com gmail.googleapis.com iam.googleapis.com`.
- **Local dev can't reach Google over HTTPS (certificate errors):** this is almost always a
  local machine issue (a corporate proxy or antivirus doing TLS interception), not a bug in
  this project — check your machine's trusted root certificates.

## Google OAuth Testing vs. longer-term use

Google Cloud OAuth clients start in **Testing** publishing status. While in Testing,
refresh tokens for sensitive/restricted scopes (which includes `gmail.readonly`) expire
after **7 days**, regardless of how few users you have — this will silently break the
connector on a weekly basis if left as-is.

The fix is **not** Google verification (a multi-month process built for public SaaS). It's
simpler: click **Publish app** to move the consent screen to **In production**. For an app
requesting only `gmail.readonly` and staying under 100 total connected Google accounts,
Google's own documentation treats this as a fully supported personal/small-scale use case —
no verification required. The only visible effect is that each newly-connected account sees
a one-time "Google hasn't verified this app" click-through warning before granting consent.
That warning is expected; it does not mean anything is misconfigured. See
[SECURITY.md](SECURITY.md#google-oauth-verification-status) for the underlying rules and
sources.

## Repository layout

```
src/            TypeScript source (server, MCP tools, admin UI, OAuth flows)
scripts/        bootstrap.sh (Cloud Shell), setup.ps1/deploy.ps1 (Windows)
.env.example    Local-dev configuration template (placeholders only)
SECURITY.md     Trust model, design rationale, known limitations
```

## License

MIT — see [LICENSE](LICENSE).
