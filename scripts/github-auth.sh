#!/usr/bin/env bash
# Gives github-mcp the user's own GitHub token, from the gh CLI (D-39). Re-run after `gh auth login`
# or `gh auth refresh`. The token never leaves the secrets dir; github-mcp re-reads it on every call.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
env_file="${PENNYWORTH_ENV_FILE:-.env}"
env_get() { sed -n "s/^$1=//p" "$env_file" | tail -1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
PENNYWORTH_SECRETS_DIR="${PENNYWORTH_SECRETS_DIR:-$(env_get PENNYWORTH_SECRETS_DIR)}"
: "${PENNYWORTH_SECRETS_DIR:?set PENNYWORTH_SECRETS_DIR in .env}"
command -v gh >/dev/null || { echo "error: gh not found; install it and run gh auth login" >&2; exit 1; }
umask 077
token="$(gh auth token 2>/dev/null || true)"
[ -n "$token" ] || { echo "error: gh has no token; run gh auth login" >&2; exit 1; }
# Rewrite in place (same inode): the running container bind-mounts this file.
f="$PENNYWORTH_SECRETS_DIR/github_token"
[ -e "$f" ] || : > "$f"
printf '%s' "$token" > "$f"
chmod 0600 "$f"
echo "GitHub token saved for github-mcp ($(gh api user --jq .login 2>/dev/null || echo 'account unknown')). Verify with scripts/healthcheck.sh"
