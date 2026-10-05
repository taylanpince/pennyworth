#!/usr/bin/env bash
# One-time read-only Slack consent for the slack-mcp sidecar (Slack's official MCP,
# Polygon's registered client from go/mcps). Uses callback http://localhost:3118/callback.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
env_file="${PENNYWORTH_ENV_FILE:-.env}"
set -a; . "$env_file"; set +a
: "${SLACK_CLIENT_ID:?set SLACK_CLIENT_ID in .env}"
dir="$PENNYWORTH_SECRETS_DIR/slack"
mkdir -p "$dir" && chmod 0700 "$dir"
node services/slack-mcp/src/auth.ts "$SLACK_CLIENT_ID" "$dir/token.json" "${SLACK_CALLBACK_PORT:-3118}"
docker compose up -d --force-recreate slack-mcp
echo "Slack connected (read-only). Verify with scripts/healthcheck.sh"
