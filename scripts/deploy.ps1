<#
.SYNOPSIS
  Deploys multi-gmail-cowork-mcp to Cloud Run from source, using whatever gcloud
  project is currently active. Idempotent  -  safe to re-run any time you change
  code or want to pick up a new secret version.

.DESCRIPTION
  Assumes scripts/setup.ps1 has already been run at least once (it creates the
  Secret Manager secrets this script references via --set-secrets, and grants the
  Cloud Run runtime service account access to them).

  On the very first deploy, this service's own public URL isn't known yet (Cloud
  Run assigns it). PUBLIC_BASE_URL must exactly match that URL for the Google
  OAuth redirect to work, so this script deploys once, reads back the assigned
  URL, and  -  only if that URL is new  -  deploys a second time with the correct
  value. Every later run is a single deploy.

.PARAMETER ServiceName
  Cloud Run service name. Defaults to "multi-gmail-mcp".

.PARAMETER Region
  Cloud Run region. Defaults to "us-central1".
#>

param(
  [string]$ServiceName = "multi-gmail-mcp",
  [string]$Region = "us-central1"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  Write-Error "gcloud CLI not found. Install it from https://cloud.google.com/sdk/docs/install, then run 'gcloud init'."
  exit 1
}

$ProjectId = (gcloud config get-value project 2>$null).Trim()
if (-not $ProjectId -or $ProjectId -eq "(unset)") {
  Write-Error "No active gcloud project. Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
}

# A dedicated, least-privilege service account (created by setup.ps1) rather than
# the project's broad default compute service account.
$ServiceAccountEmail = "$ServiceName-run@$ProjectId.iam.gserviceaccount.com"

# These secrets must already exist  -  created by scripts/setup.ps1.
$SecretRefs = @(
  "MCP_BEARER_TOKEN=mcp-bearer-token:latest",
  "ADMIN_PASSWORD=admin-password:latest",
  "OAUTH_STATE_SECRET=oauth-state-secret:latest",
  "GOOGLE_CLIENT_ID=google-client-id:latest",
  "GOOGLE_CLIENT_SECRET=google-client-secret:latest"
) -join ","

function Build-EnvArgs([string]$PublicBaseUrl) {
  return @(
    "PUBLIC_BASE_URL=$PublicBaseUrl",
    "GCP_PROJECT_ID=$ProjectId",
    "ACCOUNTS_SECRET_NAME=gmail-mcp-accounts",
    "TOKEN_STORE=secret-manager",
    "ENABLE_WRITE_TOOLS=false",
    "LOG_LEVEL=info",
    "NODE_ENV=production"
  ) -join ","
}

function Deploy([string]$PublicBaseUrl) {
  gcloud run deploy $ServiceName `
    --source . `
    --project $ProjectId `
    --region $Region `
    --allow-unauthenticated `
    --service-account $ServiceAccountEmail `
    --min-instances 0 `
    --max-instances 3 `
    --set-env-vars (Build-EnvArgs $PublicBaseUrl) `
    --set-secrets $SecretRefs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# NOTE on --allow-unauthenticated: Claude's servers are not a Google Cloud
# principal and cannot present a Cloud Run identity token, so Cloud Run IAM
# cannot gate this service. Authentication is enforced by the application
# itself instead  -  see mcpAuth.ts (bearer token on /mcp) and adminAuth.ts
# (Basic Auth on /admin). This is documented in SECURITY.md.

$existingUrl = (gcloud run services describe $ServiceName --region $Region --project $ProjectId `
  --format "value(status.url)" 2>$null)
$firstPassUrl = if ($existingUrl) { $existingUrl.Trim() } else { "https://not-yet-known.invalid" }

Write-Host "Deploying '$ServiceName' to project '$ProjectId' ($Region)..." -ForegroundColor Cyan
Deploy $firstPassUrl

$serviceUrl = (gcloud run services describe $ServiceName --region $Region --project $ProjectId `
  --format "value(status.url)").Trim()

if ($serviceUrl -ne $firstPassUrl) {
  Write-Host "Service URL is $serviceUrl  -  redeploying so PUBLIC_BASE_URL matches (needed for the OAuth redirect URI)..." -ForegroundColor Yellow
  Deploy $serviceUrl
}

Write-Host ""
Write-Host "Deployed." -ForegroundColor Green
Write-Host "  MCP endpoint (for Claude):        $serviceUrl/mcp"
Write-Host "  Admin page (connect accounts):    $serviceUrl/admin"
Write-Host "  Google OAuth redirect URI needed: $serviceUrl/oauth/google/callback"
Write-Host ""
Write-Host "If you haven't created the Google OAuth client yet, see README.md  -  the redirect URI" -ForegroundColor Yellow
Write-Host "above must match it exactly." -ForegroundColor Yellow
