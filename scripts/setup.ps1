<#
.SYNOPSIS
  One-time provisioning for multi-gmail-cowork-mcp: enables APIs, creates a
  dedicated least-privilege service account, creates the Secret Manager secrets
  this service needs, deploys it to Cloud Run, and walks you through the one
  step Google doesn't let us automate (creating the OAuth client).

  Safe to re-run  -  every step checks whether it already happened before doing
  anything.

.PARAMETER ServiceName
  Cloud Run service name. Must match what you pass to deploy.ps1. Defaults to
  "multi-gmail-mcp".

.PARAMETER Region
  Cloud Run region. Defaults to "us-central1".
#>

param(
  [string]$ServiceName = "multi-gmail-mcp",
  [string]$Region = "us-central1"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir

function Step([string]$Text) {
  Write-Host ""
  Write-Host "== $Text ==" -ForegroundColor Cyan
}

function New-RandomSecretValue {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Test-SecretExists([string]$Name) {
  gcloud secrets describe $Name --project $ProjectId 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}

function New-SecretContainer([string]$Name) {
  if (-not (Test-SecretExists $Name)) {
    gcloud secrets create $Name --project $ProjectId --replication-policy="automatic" | Out-Null
  }
}

function Set-SecretValue([string]$Name, [string]$Value) {
  # --data-file=- reads the value from stdin so it never appears as a CLI argument
  # (which would otherwise risk landing in shell history or a process listing).
  $Value | gcloud secrets versions add $Name --project $ProjectId --data-file=- | Out-Null
}

function Get-SecretValue([string]$Name) {
  return (gcloud secrets versions access latest --secret=$Name --project $ProjectId).Trim()
}

# ---------------------------------------------------------------------------
Step "Checking prerequisites"

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  Write-Error "gcloud CLI not found. Install it from https://cloud.google.com/sdk/docs/install, then run 'gcloud init' and 'gcloud auth login'."
  exit 1
}

$ProjectId = (gcloud config get-value project 2>$null).Trim()
if (-not $ProjectId -or $ProjectId -eq "(unset)") {
  Write-Error "No active gcloud project. Create one at https://console.cloud.google.com/projectcreate, then run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
}
Write-Host "Using project: $ProjectId"

# ---------------------------------------------------------------------------
Step "Enabling required Google Cloud APIs"

$Apis = @(
  "run.googleapis.com",
  "cloudbuild.googleapis.com",
  "artifactregistry.googleapis.com",
  "secretmanager.googleapis.com",
  "gmail.googleapis.com",
  "iam.googleapis.com"
)
gcloud services enable @Apis --project $ProjectId
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# ---------------------------------------------------------------------------
Step "Creating a dedicated Cloud Run service account"

$SaName = "$ServiceName-run"
$SaEmail = "$SaName@$ProjectId.iam.gserviceaccount.com"

gcloud iam service-accounts describe $SaEmail --project $ProjectId 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  gcloud iam service-accounts create $SaName `
    --project $ProjectId `
    --display-name "multi-gmail-cowork-mcp Cloud Run runtime"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  Write-Host "Service account $SaEmail already exists."
}

# ---------------------------------------------------------------------------
Step "Creating Secret Manager secrets"

$StaticSecrets = @("mcp-bearer-token", "admin-password", "oauth-state-secret")
foreach ($name in $StaticSecrets) {
  $isNew = -not (Test-SecretExists $name)
  New-SecretContainer $name
  if ($isNew) {
    Set-SecretValue $name (New-RandomSecretValue)
    Write-Host "Generated $name."
  } else {
    Write-Host "$name already exists  -  leaving its value as-is."
  }
}

$GoogleClientIdIsNew = -not (Test-SecretExists "google-client-id")
New-SecretContainer "google-client-id"
New-SecretContainer "google-client-secret"
if ($GoogleClientIdIsNew) {
  Set-SecretValue "google-client-id" "REPLACE_ME"
  Set-SecretValue "google-client-secret" "REPLACE_ME"
}

$isNewAccounts = -not (Test-SecretExists "gmail-mcp-accounts")
New-SecretContainer "gmail-mcp-accounts"
if ($isNewAccounts) {
  Set-SecretValue "gmail-mcp-accounts" "[]"
  Write-Host "Created empty account store (gmail-mcp-accounts)."
}

# ---------------------------------------------------------------------------
Step "Granting least-privilege IAM on the secrets"

$AllSecrets = @("mcp-bearer-token", "admin-password", "oauth-state-secret", "google-client-id", "google-client-secret", "gmail-mcp-accounts")
foreach ($name in $AllSecrets) {
  gcloud secrets add-iam-policy-binding $name `
    --project $ProjectId `
    --member "serviceAccount:$SaEmail" `
    --role "roles/secretmanager.secretAccessor" | Out-Null
}
# Only the account store is written to at runtime (adding accounts from the admin page).
gcloud secrets add-iam-policy-binding "gmail-mcp-accounts" `
  --project $ProjectId `
  --member "serviceAccount:$SaEmail" `
  --role "roles/secretmanager.secretVersionAdder" | Out-Null

# ---------------------------------------------------------------------------
Step "Deploying to Cloud Run (first pass  -  this discovers the service's public URL)"

Push-Location $RepoRoot
try {
  & "$ScriptDir\deploy.ps1" -ServiceName $ServiceName -Region $Region
} finally {
  Pop-Location
}

$ServiceUrl = (gcloud run services describe $ServiceName --region $Region --project $ProjectId --format "value(status.url)").Trim()

# ---------------------------------------------------------------------------
$NeedsOAuthClient = (Get-SecretValue "google-client-id") -eq "REPLACE_ME"

if ($NeedsOAuthClient) {
  Step "One manual step: create your Google OAuth client"
  Write-Host "Google does not offer a reliable API/CLI path to create a general-purpose OAuth 2.0"
  Write-Host "web-application client, so this part is done by hand in the Cloud Console:"
  Write-Host ""
  Write-Host "  1. OAuth consent screen:" -ForegroundColor Yellow
  Write-Host "     https://console.cloud.google.com/apis/credentials/consent?project=$ProjectId"
  Write-Host "     - User type: External"
  Write-Host "     - Fill in app name / support email"
  Write-Host "     - Add the scope: https://www.googleapis.com/auth/gmail.readonly"
  Write-Host "     - Save, then click 'PUBLISH APP' to move it to 'In production'."
  Write-Host "       (It stays unverified  -  you'll see a one-time 'Google hasn't verified this"
  Write-Host "       app' warning per connected account. This is expected and documented in"
  Write-Host "       README.md. Do NOT leave it in 'Testing' status: Google expires refresh"
  Write-Host "       tokens after 7 days for apps left in Testing.)"
  Write-Host ""
  Write-Host "  2. OAuth client ID:" -ForegroundColor Yellow
  Write-Host "     https://console.cloud.google.com/apis/credentials?project=$ProjectId"
  Write-Host "     - Create Credentials -> OAuth client ID -> Application type: Web application"
  Write-Host "     - Authorized redirect URI (must match exactly):"
  Write-Host "         $ServiceUrl/oauth/google/callback" -ForegroundColor Green
  Write-Host ""

  $clientId = Read-Host "Paste the OAuth Client ID"
  $clientSecretPlain = Read-Host "Paste the OAuth Client Secret" -AsSecureString
  $clientSecret = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($clientSecretPlain)
  )

  if ($clientId -and $clientSecret) {
    Set-SecretValue "google-client-id" $clientId
    Set-SecretValue "google-client-secret" $clientSecret
    Write-Host "Stored. Redeploying so the running service picks up the real OAuth client..."
    Push-Location $RepoRoot
    try {
      & "$ScriptDir\deploy.ps1" -ServiceName $ServiceName -Region $Region
    } finally {
      Pop-Location
    }
  } else {
    Write-Host "Skipped  -  the service is running but Gmail account linking will fail until you" -ForegroundColor Yellow
    Write-Host "set real values: update the google-client-id / google-client-secret secrets and" -ForegroundColor Yellow
    Write-Host "re-run this script or scripts/deploy.ps1." -ForegroundColor Yellow
  }
} else {
  Write-Host "Google OAuth client already configured  -  skipping." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
Step "Done"

$AdminPassword = Get-SecretValue "admin-password"
$McpToken = Get-SecretValue "mcp-bearer-token"

Write-Host ""
Write-Host "Admin page (connect/remove Gmail accounts):" -ForegroundColor Cyan
Write-Host "  URL:      $ServiceUrl/admin"
Write-Host "  Username: admin"
Write-Host "  Password: $AdminPassword"
Write-Host ""
Write-Host "MCP connector (add this in Claude, under Custom Connectors):" -ForegroundColor Cyan
Write-Host "  URL:          $ServiceUrl/mcp"
Write-Host "  Header name:  Authorization"
Write-Host "  Header value: Bearer $McpToken"
Write-Host ""
Write-Host "Save the admin password and MCP header value now (e.g. in a password manager)." -ForegroundColor Yellow
Write-Host "They won't be printed again by this script. You can always look them up again with:" -ForegroundColor Yellow
Write-Host "  gcloud secrets versions access latest --secret=admin-password --project $ProjectId"
Write-Host "  gcloud secrets versions access latest --secret=mcp-bearer-token --project $ProjectId"
