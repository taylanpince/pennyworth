#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh (D-58), from a local archive or an off-machine
# snapshot. Refuses to run while any Pennyworth container or the runner is running, and moves
# existing state aside instead of deleting it.
#
#   scripts/restore.sh backups/pennyworth-YYYYmmdd-HHMMSS.tar.gz
#   scripts/restore.sh --snapshot [ID]      (default latest; `restic snapshots` lists them)
#
# Paperclip's database comes back by starting Paperclip on an empty database and loading the
# dump into it with Paperclip's own restore, then restarting it.
set -euo pipefail
umask 077

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
env_file="${PENNYWORTH_ENV_FILE:-.env}"
[ -f "$env_file" ] && { set -a; . "$env_file"; set +a; }
secrets="${PENNYWORTH_SECRETS_DIR:-$HOME/.config/pennyworth}"
runner_state="${PENNYWORTH_RUNNER_STATE_DIR:-$HOME/.local/state/pennyworth-runner}"
backup_name="${PENNYWORTH_BACKUP_NAME:-pennyworth}"
runner_service="${PENNYWORTH_RUNNER_SERVICE:-pennyworth-runner}"
whatsapp_state="${PENNYWORTH_WHATSAPP_STATE_DIR:-}"
dc() { docker compose --env-file "$env_file" "$@"; }

running="$(dc ps --status running --services 2>/dev/null || true)"
if [ -n "$running" ]; then
  echo "error: refusing to restore while containers are running: $(echo $running)" >&2
  echo "       stop them first: docker compose down" >&2
  exit 1
fi
if systemctl --user is-active -q "$runner_service" 2>/dev/null; then
  echo "error: refusing to restore while the runner is running" >&2
  echo "       stop it first: systemctl --user stop $runner_service" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ "${1:-}" = --snapshot ]; then
  [ -f "$secrets/backup/restic.env" ] || { echo "error: no $secrets/backup/restic.env" >&2; exit 1; }
  set -a; . "$secrets/backup/restic.env"; set +a
  export RESTIC_PASSWORD_FILE="$secrets/backup/password"
  restic restore "${2:-latest}" --host "$backup_name" --tag "$backup_name" --target "$work/snapshot"
  src="$(dirname "$(find "$work/snapshot" -name MANIFEST -path '*/stage/MANIFEST' | head -1)")"
else
  archive="${1:?usage: scripts/restore.sh <backup.tar.gz> | --snapshot [ID]}"
  [ -f "$archive" ] || { echo "error: $archive not found" >&2; exit 1; }
  mkdir -p "$work/stage"
  tar -C "$work/stage" -xzf "$archive"
  src="$work/stage"
fi
[ -f "$src/MANIFEST" ] || { echo "error: not a Pennyworth backup" >&2; exit 1; }
[ -f "$src/paperclip/paperclip.sql" ] || { echo "error: a backup from before D-58 (no database dump); restore it with that version of this script" >&2; exit 1; }
cat "$src/MANIFEST"
if [ -f "$src/whatsapp/messages.sqlite" ] && [ -z "$whatsapp_state" ]; then
  echo "error: set PENNYWORTH_WHATSAPP_STATE_DIR for this backup" >&2; exit 1
fi

data="${PENNYWORTH_DATA_DIR:-./data}"
config="${PENNYWORTH_CONFIG_DIR:-./config}"
mkdir -p "$data"
data="$(cd "$data" && pwd)"
instance="$data/paperclip/instances/default"
aside="$data/.pre-restore-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$aside"

# Everything that will be replaced goes aside first.
[ -e "$instance" ] && { mkdir -p "$aside/paperclip"; mv "$instance" "$aside/paperclip/"; }
for d in board ops-mcp; do
  [ -e "$data/$d" ] && mv "$data/$d" "$aside/"
done
if ls "$runner_state"/state.sqlite* >/dev/null 2>&1; then
  mkdir -p "$aside/runner"
  mv "$runner_state"/state.sqlite* "$aside/runner/"
fi
if [ -f "$src/whatsapp/messages.sqlite" ]; then
  [ -n "$whatsapp_state" ] || { echo "error: set PENNYWORTH_WHATSAPP_STATE_DIR for this backup" >&2; exit 1; }
  mkdir -p "$whatsapp_state" "$aside/whatsapp"
  for f in "$whatsapp_state"/messages.sqlite*; do
    [ ! -f "$f" ] || mv "$f" "$aside/whatsapp/"
  done
  cp "$src/whatsapp/messages.sqlite" "$whatsapp_state/"
fi
echo "Previous state moved to $aside"

mkdir -p "$instance" "$data/board" "$data/ops-mcp" "$runner_state"
cp -a "$src/paperclip/instance/." "$instance/"
[ -f "$src/board/board.sqlite" ] && cp "$src/board/board.sqlite" "$data/board/"
[ -f "$src/ops-mcp/state.sqlite" ] && cp "$src/ops-mcp/state.sqlite" "$data/ops-mcp/"
[ -f "$src/runner/state.sqlite" ] && cp "$src/runner/state.sqlite" "$runner_state/"

mkdir -p "$config"
for f in "$src"/config/*.yaml "$src"/config/*.md; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  [ -f "$config/$name" ] && ! cmp -s "$f" "$config/$name" && cp "$config/$name" "$aside/$name"
  cp "$f" "$config/$name"
done
[ -d "$src/config/agents" ] && cp -r "$src/config/agents" "$config/"
# .env and compose.vault.yaml only on a fresh checkout; otherwise beside them, to compare.
if [ -f "$src/repo/env" ]; then
  if [ -f .env ]; then cmp -s "$src/repo/env" .env || cp "$src/repo/env" .env.restored; else cp "$src/repo/env" .env; fi
fi
for f in "$src"/repo/compose*.yaml; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  if [ -f "$name" ]; then cmp -s "$f" "$name" || cp "$f" "$name.restored"; else cp "$f" "$name"; fi
done
if [ -d "$src/repo/board-public" ]; then
  mkdir -p services/board/web/public
  [ ! -d services/board/web/public ] || cp -r services/board/web/public "$aside/board-public"
  cp -r "$src/repo/board-public/." services/board/web/public/
fi

echo "Starting Paperclip on an empty database to load the dump"
dc up -d paperclip
for _ in $(seq 120); do
  curl -fsS --max-time 2 http://127.0.0.1:3100/api/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS --max-time 5 http://127.0.0.1:3100/api/health >/dev/null || { echo "error: Paperclip didn't start; see docker compose logs paperclip" >&2; exit 1; }
dc cp "$src/paperclip/paperclip.sql" paperclip:/tmp/restore.sql
dc cp scripts/dev/paperclip-restore.mts paperclip:/tmp/paperclip-restore.mts
dc exec -T -w /app paperclip node --import ./server/node_modules/tsx/dist/loader.mjs /tmp/paperclip-restore.mts /tmp/restore.sql
dc exec -T paperclip rm -f /tmp/restore.sql
dc restart paperclip

[ -f .env.restored ] && echo "NOTE: .env differs from the backup's; the backup's is in .env.restored"
[ -f compose.vault.yaml.restored ] && echo "NOTE: compose.vault.yaml differs from the backup's; the backup's is in compose.vault.yaml.restored"
echo "Restored. Next:"
echo "  node scripts/paperclip-setup.mjs              # agents' Codex settings (Codex homes aren't backed up)"
echo "  docker compose up -d"
echo "  systemctl --user start $runner_service"
echo "  scripts/healthcheck.sh"
