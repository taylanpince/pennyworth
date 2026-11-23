#!/usr/bin/env bash
# Gives jira-mcp the user's Jira sign-in (D-69): site, account email and Atlassian API token
# (create one at id.atlassian.com/manage-profile/security/api-tokens). The file is re-read on
# every request, so re-running this takes effect without a restart.
#
#   scripts/jira-auth.sh https://acme.atlassian.net you@acme.io
#   (the API token is read from the terminal, never the command line)
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
env_file="${PENNYWORTH_ENV_FILE:-.env}"
env_get() { sed -n "s/^$1=//p" "$env_file" | tail -1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
PENNYWORTH_SECRETS_DIR="${PENNYWORTH_SECRETS_DIR:-$(env_get PENNYWORTH_SECRETS_DIR)}"
: "${PENNYWORTH_SECRETS_DIR:?set PENNYWORTH_SECRETS_DIR in .env}"

url="${1:-}"
email="${2:-}"
case "$url" in
  https://*.atlassian.net) : ;;
  *) echo "usage: $0 https://<site>.atlassian.net you@example.com" >&2; exit 1 ;;
esac
[ -n "$email" ] || { echo "usage: $0 https://<site>.atlassian.net you@example.com" >&2; exit 1; }

printf 'Atlassian API token (input hidden): '
IFS= read -rs token < /dev/tty
[ -n "$token" ] || { echo; echo "error: empty token" >&2; exit 1; }
echo

umask 077
f="$PENNYWORTH_SECRETS_DIR/jira_auth"
[ -e "$f" ] || : > "$f"
node -e '
  const fs = require("fs");
  const f = process.argv[1];
  const [url, email, token] = process.argv.slice(2);
  fs.writeFileSync(f, JSON.stringify({ baseUrl: url, email, token }));
' "$f" "$url" "$email" "$token"
chmod 0600 "$f"
unset token
echo "Jira sign-in saved for jira-mcp ($url as $email). Verify with scripts/healthcheck.sh"
