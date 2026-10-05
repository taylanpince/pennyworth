#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh. Refuses to run while any Pennyworth
# container is running, and moves existing state aside instead of deleting it.
#
#   scripts/restore.sh backups/pennyworth-YYYYmmdd-HHMMSS.tar.gz
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
archive="${1:?usage: scripts/restore.sh <backup.tar.gz>}"
[ -f "$archive" ] || { echo "error: $archive not found" >&2; exit 1; }
archive="$(cd "$(dirname "$archive")" && pwd)/$(basename "$archive")"
env_file="${PENNYWORTH_ENV_FILE:-.env}"
[ -f "$env_file" ] && { set -a; . "$env_file"; set +a; }

running="$(docker compose --env-file "$env_file" ps --status running --services 2>/dev/null || true)"
if [ -n "$running" ]; then
  echo "error: refusing to restore while containers are running: $(echo $running)" >&2
  echo "       stop them first: docker compose down" >&2
  exit 1
fi

data="${PENNYWORTH_DATA_DIR:-./data}"
config="${PENNYWORTH_CONFIG_DIR:-./config}"
mkdir -p "$data"
data="$(cd "$data" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tar -C "$work" -xzf "$archive"
[ -f "$work/MANIFEST" ] || { echo "error: not a Pennyworth backup" >&2; exit 1; }
cat "$work/MANIFEST"

stamp="$(date +%Y%m%d-%H%M%S)"
aside="$data/.pre-restore-$stamp"
mkdir -p "$aside"
for d in paperclip ops-mcp; do
  [ -e "$data/$d" ] && mv "$data/$d" "$aside/"
done
echo "Previous state moved to $aside"

tar -C "$data" -xf "$work/paperclip.tar"
mkdir -p "$data/ops-mcp"
[ -f "$work/ops-mcp/state.sqlite" ] && cp "$work/ops-mcp/state.sqlite" "$data/ops-mcp/state.sqlite"
for f in "$work"/config/*.yaml; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  if [ -f "$config/$name" ] && ! cmp -s "$f" "$config/$name"; then
    cp "$config/$name" "$aside/$name"
  fi
  cp "$f" "$config/$name"
done

if grep -q '^paperclip_running=yes' "$work/MANIFEST"; then
  echo "NOTE: this backup was taken while Paperclip was running, so its live database was excluded."
  echo "      Restore Paperclip's DB from its dump under $data/paperclip/instances/*/data/backups/"
  echo "      (see Paperclip docs: database backups), or use a backup taken with the stack stopped."
fi
echo "Restored. Start with: docker compose up -d"
