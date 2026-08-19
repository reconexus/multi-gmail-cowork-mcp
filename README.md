# multi-gmail-cowork-mcp

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
- **Claude <-> server auth:** a single high-entropy bearer token via Anthropic's
  custom-connector request-header feature.
- **Server <-> Google auth:** standard OAuth 2.0 with PKCE, one grant per connected Gmail
  account, `gmail.readonly` scope.
- **Account storage:** one Google Secret Manager secret holding a small JSON array
  (alias, email, refresh token). No database.
- **Admin UI:** a few unstyled HTML pages behind HTTP Basic Auth — just enough to connect
  or disconnect accounts.

## Prerequisites

- Node.js 20+ (for local development/testing only — Cloud Run builds it for you in
  production)
- A Google Cloud account and a project you control (a fresh project is fine)
- The [`gcloud` CLI](https://cloud.google.com/sdk/docs/install), authenticated
  (`gcloud init`, `gcloud auth login`)
- Windows PowerShell (the provided scripts are `.ps1`; `scripts/deploy.ps1` and
  `scripts/setup.ps1` only shell out to `gcloud`, so they'd translate easily to bash if you
  are not on Windows)
- A Claude plan that supports custom connectors (for connecting to Cowork/claude.ai)

## Quick start

### 1. Test locally first (no GCP required)

```bash
npm install
cp .env.example .env
```

Edit `.env`:
- Leave `TOKEN_STORE=file` (stores accounts in the gitignored `.local/` folder — dev only)
- Generate three secrets and paste them in:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  ```
  Use this for `MCP_BEARER_TOKEN`, `ADMIN_PASSWORD`, and `OAUTH_STATE_SECRET` (run it three
  times, once per value).
- To fully test the Gmail-linking flow locally you'll also need a real
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` with `http://localhost:<PORT>/oauth/google/callback`
  registered as a redirect URI — see step 3 below, you can do that step first and reuse the
  same OAuth client for both local testing and production (just add both redirect URIs to
  it).

```bash
npm run dev
```

Visit `http://localhost:8080/admin` (Basic Auth: `admin` / your `ADMIN_PASSWORD`) and try
connecting an account.

### 2. Deploy to your own Google Cloud project

```powershell
gcloud config set project YOUR_PROJECT_ID
./scripts/setup.ps1
```

This is interactive and will:
1. Enable the required APIs.
2. Create a dedicated, least-privilege Cloud Run service account.
3. Create the Secret Manager secrets (generating the bearer token, admin password, and
   state-signing secret for you).
4. Deploy once to Cloud Run so you learn the service's real URL.
5. Walk you through the one step Google doesn't let us automate: creating the OAuth
   consent screen and OAuth client ID (see step 3 below — `setup.ps1` prints the exact
   redirect URI to use and prompts you to paste the resulting Client ID/Secret).
6. Redeploy with the real OAuth client, and print your admin URL/password and MCP
   URL/token.

`setup.ps1` is safe to re-run — every step checks whether it's already done. Re-run
`scripts/deploy.ps1` any time you change code or just want to push a new revision.

### 3. Create the Google OAuth client (manual — Google doesn't offer a reliable API for this)

1. **OAuth consent screen:** Google Cloud Console -> APIs & Services -> OAuth consent
   screen.
   - User type: **External**
   - Add scope: `https://www.googleapis.com/auth/gmail.readonly`
   - Save, then click **Publish app** to move it to "In production" (see "Google OAuth
     Testing vs. longer-term use" below — do not leave it in Testing).
2. **OAuth client ID:** APIs & Services -> Credentials -> Create Credentials -> OAuth
   client ID.
   - Application type: **Web application**
   - Authorized redirect URI: `https://<your-service-url>/oauth/google/callback` (printed
     by `setup.ps1`/`deploy.ps1`; for local testing also add
     `http://localhost:8080/oauth/google/callback`)
3. Copy the Client ID and Client Secret into `setup.ps1` when prompted (or into `.env` for
   local dev, or update the `google-client-id`/`google-client-secret` Secret Manager
   secrets directly for an existing deployment).

### 4. Connect Gmail accounts

Open `https://<your-service-url>/admin`, sign in with the admin password `setup.ps1`
printed, enter a short alias (e.g. `work`), click **Connect account**, and complete
Google's sign-in and consent screen. The account appears in the table once Google confirms
which address you actually authorized — the alias you type is just a label; the email
address shown is always the one Google verified, never something you type yourself.

Repeat for each Gmail account.

### 5. Connect Claude Cowork

In Claude: **Customize -> Connectors -> Add custom connector**.
- URL: `https://<your-service-url>/mcp`
- Advanced settings -> Request headers (this is currently a beta feature in Claude's UI):
  - Header name: `Authorization`
  - Header value: `Bearer <your MCP bearer token>` (printed by `setup.ps1`; type the word
    `Bearer` yourself — Claude sends the header value exactly as entered, with no added
    prefix)

Ask Claude to list your connected accounts to confirm it's working.

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
  gcloud secrets delete mcp-bearer-token admin-password oauth-state-secret google-client-id google-client-secret gmail-mcp-accounts
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
- **Claude can't reach the connector / connection fails silently:** confirm the service
  URL resolves over plain HTTPS with no redirect to a different host, and that you copied
  the bearer token header exactly (`Authorization: Bearer <token>`, including the word
  "Bearer").
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
scripts/        setup.ps1, deploy.ps1 — Windows-friendly provisioning/deploy
.env.example    Local-dev configuration template (placeholders only)
SECURITY.md     Trust model, design rationale, known limitations
```

## License

MIT — see [LICENSE](LICENSE).
