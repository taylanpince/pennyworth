#!/usr/bin/env bash
# One-time consent for the primer-mcp sidecar (Primer, PRIMER_MCP_URL; Pennyworth registers as
# a public OAuth client on the fly). Uses callback http://localhost:3123/callback.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
env_file="${PENNYWORTH_ENV_FILE:-.env}"
# Read only the keys needed: .env is written for compose, which allows unquoted spaces.
env_get() { sed -n "s/^$1=//p" "$env_file" | tail -1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
PRIMER_MCP_URL="${PRIMER_MCP_URL:-$(env_get PRIMER_MCP_URL)}"
PENNYWORTH_SECRETS_DIR="${PENNYWORTH_SECRETS_DIR:-$(env_get PENNYWORTH_SECRETS_DIR)}"
export PRIMER_MCP_URL
: "${PRIMER_MCP_URL:?set PRIMER_MCP_URL in .env}"
: "${PENNYWORTH_SECRETS_DIR:?set PENNYWORTH_SECRETS_DIR in .env}"
dir="$PENNYWORTH_SECRETS_DIR/primer"
mkdir -p "$dir" && chmod 0700 "$dir"
node services/primer-mcp/src/auth.ts "$dir/token.json" "${PRIMER_CALLBACK_PORT:-3123}"
docker compose up -d --force-recreate primer-mcp
echo "Primer connected. Verify with scripts/healthcheck.sh"
