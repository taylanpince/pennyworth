#!/usr/bin/env bash
# Back up system-owned state only: Paperclip's data directory, the ops-mcp SQLite
# database and non-secret configuration. The Obsidian vault and the secrets directory
# are NOT included (the vault has its own sync/backup; secrets stay where they are).
#
#   scripts/backup.sh [output-dir]      → <output-dir>/pennyworth-YYYYmmdd-HHMMSS.tar.gz
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
env_file="${PENNYWORTH_ENV_FILE:-.env}"
[ -f "$env_file" ] && { set -a; . "$env_file"; set +a; }
data="$(cd "${PENNYWORTH_DATA_DIR:-./data}" && pwd)"
config="$(cd "${PENNYWORTH_CONFIG_DIR:-./config}" && pwd)"
out_dir="${1:-$repo/backups}"
mkdir -p "$out_dir"
stamp="$(date +%Y%m%d-%H%M%S)"
archive="$out_dir/pennyworth-$stamp.tar.gz"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

running="$(docker compose --env-file "$env_file" ps --status running --services 2>/dev/null || true)"

echo "Backing up to $archive"
mkdir -p "$work/ops-mcp" "$work/config"

# ops-mcp: consistent online copy via SQLite's backup API.
if [ -f "$data/ops-mcp/state.sqlite" ]; then
  node --disable-warning=ExperimentalWarning -e '
    const { DatabaseSync, backup } = require("node:sqlite");
    const src = new DatabaseSync(process.argv[1], { readOnly: true });
    backup(src, process.argv[2]).then(() => src.close());
  ' "$data/ops-mcp/state.sqlite" "$work/ops-mcp/state.sqlite"
fi

# Paperclip: its embedded Postgres must not be copied mid-write. Use Paperclip's own
# hourly DB dumps if the stack is running; copy the whole directory when stopped.
if echo "$running" | grep -qx paperclip; then
  echo "  paperclip is running: archiving its data dir except the live database"
  tar -C "$data" --exclude='paperclip/instances/*/db' -cf "$work/paperclip.tar" paperclip
  latest_dump="$(ls -1t "$data"/paperclip/instances/*/data/backups/* 2>/dev/null | head -1 || true)"
  [ -n "$latest_dump" ] && echo "  includes Paperclip DB dump: $(basename "$latest_dump")" || echo "  WARNING: no Paperclip DB dump yet; stop the stack for a full backup"
else
  tar -C "$data" -cf "$work/paperclip.tar" paperclip
fi

# Config without secrets (secrets live in PENNYWORTH_SECRETS_DIR, outside the repo).
for f in system.yaml routing.yaml paperclip.yaml; do
  [ -f "$config/$f" ] && cp "$config/$f" "$work/config/"
done
cp -r "$config/agents" "$work/config/" 2>/dev/null || true

printf 'created=%s\nhost=%s\npaperclip_running=%s\n' "$stamp" "$(hostname)" "$(echo "$running" | grep -qx paperclip && echo yes || echo no)" > "$work/MANIFEST"
tar -C "$work" -czf "$archive" .
chmod 0600 "$archive"
echo "Done: $archive ($(du -h "$archive" | cut -f1))"
