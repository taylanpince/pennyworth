#!/usr/bin/env bash
# Signs Pennyworth in to AWS IAM Identity Center for Engineer jobs (D-59): `aws sso login` into
# Pennyworth's own AWS home ($PENNYWORTH_SECRETS_DIR/aws), leaving your ~/.aws alone. Run it again when
# the Identity Center session ends: the runner says so on the task. Jobs only ever get one-hour
# credentials for each account's read role (services/runner/src/aws.mjs); the write roles are used by
# the runner alone, for `pennyworth aws` commands your words ask for. Opens a browser for the sign-in,
# then lists the accounts and roles it reaches and checks the ones in config/runner.yaml (aws:).
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
env_file="${PENNYWORTH_ENV_FILE:-.env}"
env_get() { sed -n "s/^$1=//p" "$env_file" | tail -1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
export PENNYWORTH_SECRETS_DIR="${PENNYWORTH_SECRETS_DIR:-$(env_get PENNYWORTH_SECRETS_DIR)}"
: "${PENNYWORTH_SECRETS_DIR:?set PENNYWORTH_SECRETS_DIR in .env}"
umask 077

# The profiles come from config/runner.yaml; the sign-in needs only its sso-session.
home="$(node --input-type=module -e "
import { loadConfig } from '$repo/services/runner/src/config.mjs';
import { writeProfiles } from '$repo/services/runner/src/aws.mjs';
const { aws } = loadConfig();
if (!aws.sso.startUrl || !aws.sso.region) { console.error('error: set aws.sso_start_url and aws.sso_region in config/runner.yaml'); process.exit(1); }
writeProfiles(aws);
console.log(aws.home);
")"
chmod 0700 "$home"

# Pennyworth's own home: the CLI keeps SSO tokens under ~/.aws/sso/cache, with no setting to move them.
# The browser still opens with your own home, so your sign-ins there apply.
HOME="$home" AWS_CONFIG_FILE="$home/.aws/config" BROWSER="env HOME=$HOME xdg-open %s" \
  aws sso login --sso-session pennyworth

node --input-type=module -e "
import { loadConfig } from '$repo/services/runner/src/config.mjs';
import { assignments, roleCredentials } from '$repo/services/runner/src/aws.mjs';
const { aws } = loadConfig();
const fail = (e) => { console.error('error: ' + e.message); process.exit(1); };
const reached = await assignments(aws).catch(fail);
console.log('\nAWS signed in for Pennyworth. Accounts and roles it reaches:');
for (const a of reached) console.log('  ' + a.id + '  ' + a.name.padEnd(32) + a.roles.join(', '));
if (!aws.accounts.length) {
  console.log('\nNo accounts in config/runner.yaml yet. Add the ones jobs should reach under aws.accounts, with a read-only role');
  console.log('(read_role, e.g. ReadOnlyAccess) and, for changes on your word, a write_role; then run this again.');
  process.exit(0);
}
let bad = 0;
console.log('\nConfigured accounts (jobs get one-hour credentials for the read role):');
for (const account of aws.accounts) {
  for (const kind of ['read', 'write']) {
    const role = kind === 'read' ? account.readRole : account.writeRole;
    if (!role) continue;
    const r = await roleCredentials({ aws, account, kind }).then((c) => 'ok, valid until ' + new Date(c.expiresAt).toLocaleTimeString(), (e) => (bad++, 'FAILED: ' + e.message));
    console.log('  ' + account.name.padEnd(28) + (kind + ' ' + role).padEnd(32) + r);
  }
}
process.exit(bad ? 1 : 0);
"
