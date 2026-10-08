#!/usr/bin/env bash
# One-time read-only Telegram consent for the telegram-mcp sidecar (your organization's Telegram
# MCP, TELEGRAM_MCP_URL; Pennyworth registers as a public OAuth client on the fly).
# Uses callback http://localhost:3119/callback.
# Which chats Pennyworth sees is the server's allowlist: change it in the server's chat picker.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
env_file="${PENNYWORTH_ENV_FILE:-.env}"
set -a; . "$env_file"; set +a
: "${TELEGRAM_MCP_URL:?set TELEGRAM_MCP_URL in .env}"
dir="$PENNYWORTH_SECRETS_DIR/telegram"
mkdir -p "$dir" && chmod 0700 "$dir"
node services/telegram-mcp/src/auth.ts "$dir/token.json" "${TELEGRAM_CALLBACK_PORT:-3119}"
docker compose up -d --force-recreate telegram-mcp
echo "Telegram connected (read-only). Verify with scripts/healthcheck.sh"
