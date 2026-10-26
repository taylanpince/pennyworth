#!/usr/bin/env bash
# Signs Pennyworth in to Google Cloud for Engineer jobs (D-48). Run it again when the 16-hour Google
# Cloud session ends: the runner says so on the task. gcloud insists on cloud-platform for this login;
# jobs only ever get a one-hour token narrowed to read-only scopes (services/runner/src/gcp.mjs), and
# this sign-in stays hidden from them. Opens a browser for the Google sign-in.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
env_file="${PENNYWORTH_ENV_FILE:-.env}"
env_get() { sed -n "s/^$1=//p" "$env_file" | tail -1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
PENNYWORTH_SECRETS_DIR="${PENNYWORTH_SECRETS_DIR:-$(env_get PENNYWORTH_SECRETS_DIR)}"
: "${PENNYWORTH_SECRETS_DIR:?set PENNYWORTH_SECRETS_DIR in .env}"
dir="${PENNYWORTH_SECRETS_DIR/#\~/$HOME}/gcloud"
umask 077
mkdir -p "$dir" && chmod 0700 "$dir"
scopes="$(node --input-type=module -e "import { LOGIN_SCOPES } from '$repo/services/runner/src/gcp.mjs'; console.log(LOGIN_SCOPES.join(','))")"
run_gcloud() {
  if command -v gcloud >/dev/null; then gcloud "$@"; else nix develop "${PENNYWORTH_DEVSHELLS:-$HOME/config/nixos}#pulumi" --command gcloud "$@"; fi
}
# Pennyworth's own gcloud directory: your ~/.config/gcloud is left alone.
CLOUDSDK_CONFIG="$dir" run_gcloud auth application-default login --scopes="$scopes" --disable-quota-project
chmod 0600 "$dir/application_default_credentials.json"
# Prove the narrowing: a read-only token, and nothing wider.
node --input-type=module -e "
import { readOnlyToken } from '$repo/services/runner/src/gcp.mjs';
const r = await readOnlyToken('$dir/application_default_credentials.json').catch((e) => { console.error('error: ' + e.message); process.exit(1); });
console.log('Google Cloud signed in for Pennyworth. Jobs get read-only tokens (valid until ' + new Date(r.expiresAt).toLocaleTimeString() + ', refreshed while they run).');
"
