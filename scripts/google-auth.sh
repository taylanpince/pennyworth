#!/usr/bin/env bash
# One-time read-only Google consent for the google-workspace-mcp sidecar.
#
#   scripts/google-auth.sh ~/Downloads/client_secret_XXXX.json
#
# Needs a "Desktop app" OAuth client from a Google Cloud project with the Calendar API
# and Drive API enabled. Requests only calendar.events.readonly and drive.readonly.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
client="${1:?usage: scripts/google-auth.sh <client_secret.json>}"
env_file="${PENNYWORTH_ENV_FILE:-.env}"
set -a; . "$env_file"; set +a
out="$PENNYWORTH_SECRETS_DIR/google_oauth.json"
node services/google-workspace-mcp/src/auth.ts "$client" "$out"
chmod 0600 "$out"
docker compose up -d --force-recreate google-workspace-mcp
echo "Google connected (read-only). Verify with scripts/healthcheck.sh"
