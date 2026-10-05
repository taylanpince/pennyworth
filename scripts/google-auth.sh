#!/usr/bin/env bash
# Read-only Google consent for the google-workspace-mcp sidecar, one account at a time.
# Connect several accounts by running it once per account:
#   scripts/google-auth.sh --email you@work.com --primary   # Calendar + meeting docs come from here
#   scripts/google-auth.sh --email you@side.io              # adds Gmail/Drive of a second account
#
#   scripts/google-auth.sh ~/Downloads/client_secret_XXXX.json
#   scripts/google-auth.sh            (reuses the client on file, or prompts for client ID and secret)
#
# Needs a "Desktop app" OAuth client from a Google Cloud project with the Calendar API
# and Drive API enabled. Requests only calendar.events.readonly and drive.readonly.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
env_file="${PENNYWORTH_ENV_FILE:-.env}"
set -a; . "$env_file"; set +a
out="$PENNYWORTH_SECRETS_DIR/google_oauth.json"
extra=()
client=""
while [ $# -gt 0 ]; do
  case "$1" in
    --email) extra+=(--email "$2"); shift 2 ;;
    --primary) extra+=(--primary); shift ;;
    *) client="$1"; shift ;;
  esac
done
if [ -z "$client" ] && [ -s "$out" ] && node -e 'const j=require(process.argv[1]);process.exit(j.client_id?0:1)' "$out" 2>/dev/null; then
  # Re-consent (e.g. after new scopes were added) with the client already on file.
  umask 077
  client="$(mktemp "$PENNYWORTH_SECRETS_DIR/.client.XXXXXX")"
  trap 'rm -f "$client"' EXIT
  node -e 'const j=require(process.argv[1]);console.log(JSON.stringify({installed:{client_id:j.client_id,client_secret:j.client_secret}}))' "$out" > "$client"
  echo "Reusing the OAuth client from $out"
fi
if [ -z "$client" ]; then
  # No JSON download available: build the client file from prompts (secret not echoed).
  read -r -p "OAuth client ID: " client_id
  read -r -s -p "OAuth client secret: " client_secret; echo
  [ -n "$client_id" ] && [ -n "$client_secret" ] || { echo "error: both values are required" >&2; exit 1; }
  umask 077
  client="$(mktemp "$PENNYWORTH_SECRETS_DIR/.client.XXXXXX")"
  trap 'rm -f "$client"' EXIT
  CLIENT_ID="$client_id" CLIENT_SECRET="$client_secret" node -e \
    'console.log(JSON.stringify({installed:{client_id:process.env.CLIENT_ID,client_secret:process.env.CLIENT_SECRET}}))' > "$client"
fi
node services/google-workspace-mcp/src/auth.ts "$client" "$out" "${extra[@]}"
chmod 0600 "$out"
docker compose up -d --force-recreate google-workspace-mcp
echo "Google connected (read-only). Verify with scripts/healthcheck.sh"
