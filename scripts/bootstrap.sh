#!/usr/bin/env bash
# Provision and deploy Multi-Gmail Cowork MCP from Google Cloud Shell.
#
# This script is intentionally idempotent: existing services, secrets, account
# data, and OAuth credentials are preserved. It creates only missing resources
# and adds new secret versions only when a value is first needed.

set -Eeuo pipefail
IFS=$'\n\t'

script_name="$(basename "$0")"
service_name="${SERVICE_NAME:-multi-gmail-mcp}"
region_name="${REGION:-us-central1}"
accounts_secret_name="${ACCOUNTS_SECRET_NAME:-gmail-mcp-accounts}"
project_id="${GCP_PROJECT_ID:-}"
runtime_sa_email=""
service_url=""
oauth_client_needed="false"

usage() {
  cat <<'EOF'
Multi-Gmail Cowork MCP Cloud Shell bootstrap

Usage:
  ./scripts/bootstrap.sh           Provision/deploy and show the setup wizard
  ./scripts/bootstrap.sh --check   Check local Cloud Shell prerequisites only
  ./scripts/bootstrap.sh --help    Show this help

Optional environment variables:
  GCP_PROJECT_ID       Use this project instead of the active gcloud project
  SERVICE_NAME         Cloud Run service name (default: multi-gmail-mcp)
  REGION               Cloud Run region (default: us-central1)
EOF
}

fail() {
  printf 'FAIL  %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'PASS  %s\n' "$*"
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Cloud Shell is missing '$1'. Open this repository with the Open in Cloud Shell button and try again."
}

secret_exists() {
  gcloud secrets describe "$1" --project "$project_id" >/dev/null 2>&1
}

ensure_secret() {
  local secret_name="$1"
  if secret_exists "$secret_name"; then
    printf '  Existing Secret Manager secret: %s\n' "$secret_name"
  else
    gcloud secrets create "$secret_name" --project "$project_id" --replication-policy=automatic --quiet >/dev/null
    printf '  Created Secret Manager secret: %s\n' "$secret_name"
  fi
}

read_secret() {
  gcloud secrets versions access latest --secret="$1" --project "$project_id" 2>/dev/null || true
}

write_secret() {
  # printf is deliberate: unlike echo or a shell pipeline that serializes a
  # string, it writes exactly the supplied bytes and never appends a newline.
  local secret_name="$1"
  local secret_value="$2"
  printf %s "$secret_value" | gcloud secrets versions add "$secret_name" --project "$project_id" --data-file=- --quiet >/dev/null
}

ensure_secret_value() {
  local secret_name="$1"
  local value="$2"
  local current
  current="$(read_secret "$secret_name")"
  if [[ -z "$current" ]]; then
    write_secret "$secret_name" "$value"
    printf '  Generated initial value for %s (value hidden)\n' "$secret_name"
  else
    printf '  Preserved existing value for %s\n' "$secret_name"
  fi
}

grant_runtime_access() {
  local secret_name="$1"
  gcloud secrets add-iam-policy-binding "$secret_name" \
    --project "$project_id" \
    --member "serviceAccount:$runtime_sa_email" \
    --role roles/secretmanager.secretAccessor \
    --quiet >/dev/null
}

service_exists() {
  gcloud run services describe "$service_name" --project "$project_id" --region "$region_name" >/dev/null 2>&1
}

existing_public_base_url() {
  if ! service_exists; then
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    return 0
  fi
  gcloud run services describe "$service_name" \
    --project "$project_id" --region "$region_name" \
    --format=json 2>/dev/null \
    | jq -r '.spec.template.spec.containers[0].env[]? | select(.name == "PUBLIC_BASE_URL") | .value // empty' 2>/dev/null \
    | head -n 1
}

deploy_once() {
  local base_url="$1"
  local secret_refs="ADMIN_PASSWORD=admin-password:latest,OAUTH_STATE_SECRET=oauth-state-secret:latest,GOOGLE_CLIENT_ID=google-client-id:latest,GOOGLE_CLIENT_SECRET=google-client-secret:latest"
  local env_vars="PUBLIC_BASE_URL=$base_url,GCP_PROJECT_ID=$project_id,ACCOUNTS_SECRET_NAME=$accounts_secret_name,MCP_OAUTH_STATE_SECRET_NAME=mcp-oauth-state,TOKEN_STORE=secret-manager,ENABLE_WRITE_TOOLS=true,LOG_LEVEL=info,NODE_ENV=production"
  gcloud run deploy "$service_name" \
    --source . \
    --project "$project_id" \
    --region "$region_name" \
    --allow-unauthenticated \
    --service-account "$runtime_sa_email" \
    --min-instances 0 \
    --max-instances 3 \
    --set-env-vars "$env_vars" \
    --set-secrets "$secret_refs" \
    --quiet >/dev/null
}

check_http() {
  local expected_path="$1"
  local expected_code="$2"
  local actual_code
  actual_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "${service_url}${expected_path}" || true)"
  [[ "$actual_code" == "$expected_code" ]]
}

check_mcp_auth() {
  local path="${1:-/mcp}"
  local actual_code
  actual_code="$(curl -sS -X POST -o /dev/null -w '%{http_code}' --max-time 30 "${service_url}${path}" || true)"
  [[ "$actual_code" == "401" ]]
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

need_command gcloud
need_command curl
need_command openssl

if [[ "${1:-}" == "--check" ]]; then
  need_command gcloud
  need_command curl
  need_command openssl
  acct="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1)"
  if [[ -z "$acct" ]]; then fail "No active gcloud login. Run: gcloud auth login"; fi
  pass "gcloud authenticated as ${acct}"
  active_project="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
  if [[ -z "$active_project" || "$active_project" == "(unset)" ]]; then
    printf 'PASS  Cloud Shell prerequisites OK; no project selected yet (bootstrap will prompt for one).\n'
  else
    pass "Active project: ${active_project}"
    billing="$(gcloud beta billing projects describe "$active_project" --format='value(billingAccountName)' 2>/dev/null || true)"
    if [[ -n "$billing" ]]; then pass "Billing linked (${billing##*/})"; else printf 'WARN  Billing not linked to %s\n' "$active_project"; fi
    if gcloud run services describe "$service_name" --project "$active_project" --region "$region_name" >/dev/null 2>&1; then
      pass "Existing Cloud Run service '$service_name' detected (will be updated, not recreated)"
    else
      printf 'INFO  No existing Cloud Run service (bootstrap will create one)\n'
    fi
  fi
  printf '\n--check is read-only: it changes nothing. Run ./scripts/bootstrap.sh to provision/deploy.\n'
  exit 0
fi

printf '\nMulti-Gmail Cowork MCP bootstrap\n'
printf 'This is safe to rerun: existing secrets, Gmail accounts, and deployments are preserved.\n\n'

gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1 >/dev/null \
  || fail "No active gcloud login. Run: gcloud auth login"

if [[ -z "$project_id" ]]; then
  active_project="$(gcloud config get-value project 2>/dev/null || true)"
  if [[ -n "$active_project" && "$active_project" != "(unset)" ]]; then
    printf 'Use active Google Cloud project "%s"? [Y/n] ' "$active_project"
    read -r project_answer
    if [[ -z "$project_answer" || "$project_answer" =~ ^[Yy]$ ]]; then
      project_id="$active_project"
    fi
  fi
fi

if [[ -z "$project_id" ]]; then
  printf '\nAvailable projects:\n'
  gcloud projects list --format='table(projectId,name,lifecycleState)' || true
  printf '\nEnter an existing project ID, or type new to create one: '
  read -r project_choice
  if [[ "$project_choice" == "new" ]]; then
    printf 'Enter a short display name (for example, My Multi Gmail): '
    read -r project_display_name
    project_slug="$(printf '%s' "$project_display_name" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-' | cut -c1-20)"
    project_slug="${project_slug:-multi-gmail}"
    project_id="${project_slug}-$(openssl rand -hex 3)"
    gcloud projects create "$project_id" --name "$project_display_name" --quiet >/dev/null
    printf 'Created project %s. Billing must be linked before deployment.\n' "$project_id"
  else
    [[ -n "$project_choice" ]] || fail "A Google Cloud project is required."
    project_id="$project_choice"
  fi
fi

gcloud config set project "$project_id" --quiet >/dev/null
printf 'Using Google Cloud project: %s\n' "$project_id"

printf '\nChecking billing...\n'
billing_account="$(gcloud beta billing projects describe "$project_id" --format='value(billingAccountName)' 2>/dev/null || true)"
if [[ -z "$billing_account" ]]; then
  printf 'FAIL  Billing is not linked to this project.\n'
  printf '      Enable/link billing here, then rerun this command:\n'
  printf '      https://console.cloud.google.com/billing/linkedaccount?project=%s\n' "$project_id"
  exit 1
fi
pass "Billing is enabled"

printf '\nEnabling required APIs...\n'
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com gmail.googleapis.com iam.googleapis.com \
  --project "$project_id" --quiet >/dev/null
pass "Required APIs are enabled"

runtime_sa_name="${service_name}-run"
runtime_sa_email="$runtime_sa_name@$project_id.iam.gserviceaccount.com"
printf '\nCreating runtime service account...\n'
if gcloud iam service-accounts describe "$runtime_sa_email" --project "$project_id" >/dev/null 2>&1; then
  printf '  Preserved existing service account %s\n' "$runtime_sa_email"
else
  gcloud iam service-accounts create "$runtime_sa_name" \
    --project "$project_id" \
    --display-name 'Multi-Gmail Cowork MCP Cloud Run runtime' \
    --quiet >/dev/null
  printf '  Created service account %s\n' "$runtime_sa_email"
fi

printf '\nCreating/preserving Secret Manager values...\n'
ensure_secret_value admin-password "$(openssl rand -hex 24)"
ensure_secret_value oauth-state-secret "$(openssl rand -hex 32)"
ensure_secret google-client-id
ensure_secret google-client-secret
ensure_secret "$accounts_secret_name"
if [[ -z "$(read_secret google-client-id)" ]]; then write_secret google-client-id REPLACE_ME; fi
if [[ -z "$(read_secret google-client-secret)" ]]; then write_secret google-client-secret REPLACE_ME; fi
if [[ -z "$(read_secret "$accounts_secret_name")" ]]; then write_secret "$accounts_secret_name" '[]'; fi

ensure_secret mcp-oauth-state
if [[ -z "$(read_secret mcp-oauth-state)" ]]; then write_secret mcp-oauth-state '{"clients":[],"authorizationCodes":{},"refreshTokens":{}}'; fi

for secret_name in admin-password oauth-state-secret google-client-id google-client-secret "$accounts_secret_name" mcp-oauth-state; do
  grant_runtime_access "$secret_name"
done
gcloud secrets add-iam-policy-binding "$accounts_secret_name" \
  --project "$project_id" --member "serviceAccount:$runtime_sa_email" \
  --role roles/secretmanager.secretVersionAdder --quiet >/dev/null
gcloud secrets add-iam-policy-binding mcp-oauth-state \
  --project "$project_id" --member "serviceAccount:$runtime_sa_email" \
  --role roles/secretmanager.secretVersionAdder --quiet >/dev/null
pass "Least-privilege Secret Manager IAM is configured"

was_existing="false"
if service_exists; then was_existing="true"; fi
base_url="$(existing_public_base_url || true)"
preserve_public_base_url="false"
if [[ -n "$base_url" ]]; then preserve_public_base_url="true"; fi
if [[ -z "$base_url" && "$was_existing" == "true" ]]; then
  base_url="$(gcloud run services describe "$service_name" --project "$project_id" --region "$region_name" --format='value(status.url)')"
fi
if [[ -z "$base_url" ]]; then base_url='https://not-yet-known.invalid'; fi

printf '\nDeploying Cloud Run service...\n'
deploy_once "$base_url"
status_service_url="$(gcloud run services describe "$service_name" --project "$project_id" --region "$region_name" --format='value(status.url)')"
service_url="$status_service_url"
if [[ "$preserve_public_base_url" != "true" && "$base_url" != "$status_service_url" ]]; then
  printf '  Cloud Run URL is now known; applying it to PUBLIC_BASE_URL.\n'
  deploy_once "$status_service_url"
  base_url="$status_service_url"
  service_url="$status_service_url"
elif [[ "$preserve_public_base_url" == "true" ]]; then
  # Keep the deployment's existing public base URL (which may be a stable
  # run.app hostname different from Cloud Run's status.url alias).
  service_url="$base_url"
fi
pass "Cloud Run deployment is ready"

client_id_value="$(read_secret google-client-id)"
client_secret_value="$(read_secret google-client-secret)"
if [[ -z "$client_id_value" || -z "$client_secret_value" || "$client_id_value" == REPLACE_ME || "$client_secret_value" == REPLACE_ME ]]; then
  oauth_client_needed="true"
  printf '\nONE browser step: create the Google OAuth web client\n'
  printf '1. Open: https://console.cloud.google.com/auth/clients?project=%s\n' "$project_id"
  printf '   OAuth consent screen:\n'
  printf '     - User type: External; fill in app name + support email.\n'
  printf '     - Add scope: https://www.googleapis.com/auth/gmail.modify\n'
  printf '     - Add your own Gmail addresses as test users.\n'
  printf '     - Click "Publish app" to move to In production. It stays unverified (a one-time\n'
  printf '       "Google has not verified this app" click-through per account is expected and fine).\n'
  printf '       Do NOT leave it in Testing: Google expires refresh tokens after 7 days for apps\n'
  printf '       left in Testing, which would silently break the connector every week.\n'
  printf '2. Create an OAuth client (Web application) with this exact authorized redirect URI:\n'
  printf '   %s/oauth/google/callback\n' "$service_url"
  printf 'Google does not provide a safe, supported CLI/API shortcut for this OAuth client creation.\n'
  printf 'Paste the resulting Client ID (it will remain hidden from normal output): '
  read -r client_id_input
  printf 'Paste the Client Secret (input is hidden): '
  read -rs client_secret_input
  printf '\n'
  if [[ -n "$client_id_input" && -n "$client_secret_input" ]]; then
    write_secret google-client-id "$client_id_input"
    write_secret google-client-secret "$client_secret_input"
    unset client_id_input client_secret_input client_id_value client_secret_value
    deploy_once "$base_url"
    oauth_client_needed="false"
    pass "OAuth client stored and deployment updated"
  else
    unset client_id_input client_secret_input client_id_value client_secret_value
    printf 'FAIL  OAuth client was not entered; Gmail account linking is not ready yet.\n'
  fi
else
  unset client_id_value client_secret_value
  pass "OAuth client is already configured"
fi

printf '\nRunning public endpoint checks...\n'
if check_http /status 200; then pass '/status returns 200'; else printf 'FAIL  /status did not return 200\n'; fi
if check_http /admin 401; then pass '/admin is protected (401 without credentials)'; else printf 'FAIL  /admin protection check failed\n'; fi
if [[ "$oauth_client_needed" == "false" ]]; then
  if check_mcp_auth /mcp; then pass '/mcp is protected (401 without OAuth access token)'; else printf 'FAIL  /mcp protection check failed\n'; fi
  if check_mcp_auth /claude-mcp; then pass '/claude-mcp is protected (401 without OAuth access token)'; else printf 'FAIL  /claude-mcp protection check failed\n'; fi
fi

printf '\nFinal setup summary\n'
printf 'Admin URL:          %s/admin\n' "$service_url"
printf 'OAuth callback URL: %s/oauth/google/callback\n' "$service_url"
printf 'MCP URL:            %s/claude-mcp\n' "$service_url"
printf 'Admin password:     retrieve it once with the command below (never printed here):\n'
printf '    gcloud secrets versions access latest --secret=admin-password --project=%s\n' "$project_id"
printf '                     sign in to the Admin URL with username "admin" + that password.\n'
if [[ -n "$billing_account" ]]; then
  printf 'Budget alert (opt): https://console.cloud.google.com/billing/%s/budgets\n' "${billing_account##*/}"
fi
printf 'Next human action:  '
if [[ "$oauth_client_needed" == "true" ]]; then
  printf 'complete the OAuth client step above, then rerun ./scripts/bootstrap.sh.\n'
else
  printf 'open the Admin URL, add Gmail accounts, then add one Claude custom connector.\n'
  printf 'Claude will discover OAuth when you click Connect; authorize it with the deployment admin credential.\n'
fi
printf 'Secret values and tokens were not printed.\n'
