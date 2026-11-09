#!/usr/bin/env bash
# Back up Pennyworth's own state (D-58): Paperclip's database (its newest hourly dump) and
# instance files, the board, ops-mcp and runner SQLite databases, and configuration. Not the
# Obsidian vault (it has its own sync), the secrets directory, or anything rebuilt on its own
# (run logs, Codex homes, task workspaces and clones).
#
#   scripts/backup.sh [output-dir]   → <output-dir>/pennyworth-YYYYmmdd-HHMMSS.tar.gz (default backups/)
#   scripts/backup.sh --init         → create the encrypted restic repository off the machine
#   scripts/backup.sh --offsite      → a restic snapshot off the machine (the hourly timer runs this)
#   scripts/backup.sh --verify [ID]  → restore a snapshot (default latest) to a scratch directory and
#                                      load it into a throwaway Postgres, to prove it restores
#
# Off-machine backups read the repository and its keys from $PENNYWORTH_SECRETS_DIR/backup/restic.env
# (RESTIC_REPOSITORY=s3:…, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) and the encryption password from
# $PENNYWORTH_SECRETS_DIR/backup/password. Keep a copy of that password somewhere else: without it no
# snapshot can be read. Each --offsite run writes data/board/backup.json for the board's banner.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
env_file="${PENNYWORTH_ENV_FILE:-.env}"
[ -f "$env_file" ] && { set -a; . "$env_file"; set +a; }
data="$(cd "${PENNYWORTH_DATA_DIR:-./data}" && pwd)"
config="$(cd "${PENNYWORTH_CONFIG_DIR:-./config}" && pwd)"
secrets="${PENNYWORTH_SECRETS_DIR:-$HOME/.config/pennyworth}"
runner_state="${PENNYWORTH_RUNNER_STATE_DIR:-$HOME/.local/state/pennyworth-runner}"
instance="$data/paperclip/instances/default"
cache="${XDG_CACHE_HOME:-$HOME/.cache}/pennyworth-backup"
status_file="$data/board/backup.json"
# Paperclip dumps every hour; an older newest dump while it runs means its backups stopped.
max_dump_age_min=150

mode=archive
case "${1:-}" in
  --init | --offsite | --verify) mode="${1#--}"; shift ;;
esac

# A consistent copy of every SQLite database, through SQLite's online backup API.
sqlite_copy() { # src dst
  [ -f "$1" ] || return 0
  mkdir -p "$(dirname "$2")"
  node --disable-warning=ExperimentalWarning -e '
    const { DatabaseSync, backup } = require("node:sqlite");
    const src = new DatabaseSync(process.argv[1], { readOnly: true });
    backup(src, process.argv[2]).then(() => src.close());
  ' "$1" "$2"
}

paperclip_running() {
  docker compose --env-file "$env_file" ps --status running --services 2>/dev/null | grep -qx paperclip
}

# Everything a restore needs, in one directory: stage <dir>.
stage() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir/paperclip" "$dir/config" "$dir/repo"

  local running=no
  paperclip_running && running=yes

  # Paperclip's database: its own hourly dump (a consistent pg_dump-style script), kept
  # uncompressed so each snapshot only uploads what changed.
  local dump
  dump="$(ls -1t "$instance"/data/backups/paperclip-*.sql.gz 2>/dev/null | head -1 || true)"
  [ -n "$dump" ] || { echo "error: no Paperclip database dump in $instance/data/backups" >&2; return 1; }
  local age_min=$(( ($(date +%s) - $(stat -c %Y "$dump")) / 60 ))
  if [ "$running" = yes ] && [ "$age_min" -gt "$max_dump_age_min" ]; then
    echo "error: Paperclip's newest database dump is ${age_min} minutes old; its hourly backups have stopped" >&2
    return 1
  fi
  gzip -dc "$dump" > "$dir/paperclip/paperclip.sql"
  tail -c 200 "$dir/paperclip/paperclip.sql" | grep -q '^COMMIT;' || { echo "error: $(basename "$dump") is incomplete" >&2; return 1; }

  # Instance files the dump doesn't hold: the secrets master key (without it the database's
  # encrypted secrets can't be read), uploads and attachments, agent instructions.
  mkdir -p "$dir/paperclip/instance"
  tar -C "$instance" \
    --exclude=./db --exclude=./locks --exclude=./data/backups --exclude=./data/run-logs \
    --exclude='./companies/*/codex-home' \
    -cf - . | tar -C "$dir/paperclip/instance" -xf -

  sqlite_copy "$data/board/board.sqlite" "$dir/board/board.sqlite"
  sqlite_copy "$data/ops-mcp/state.sqlite" "$dir/ops-mcp/state.sqlite"
  sqlite_copy "$runner_state/state.sqlite" "$dir/runner/state.sqlite"

  # Personal configuration (no secrets: those stay in $PENNYWORTH_SECRETS_DIR).
  for f in "$config"/*.yaml; do
    case "$f" in *.example.yaml) continue ;; esac
    cp "$f" "$dir/config/"
  done
  cp -r "$config/agents" "$dir/config/" 2>/dev/null || true
  [ -f "$env_file" ] && cp "$env_file" "$dir/repo/env"
  [ -f compose.vault.yaml ] && cp compose.vault.yaml "$dir/repo/"

  printf 'created=%s\nhost=%s\npaperclip_running=%s\npaperclip_dump=%s\ncommit=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname)" "$running" "$(basename "$dump")" \
    "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" > "$dir/MANIFEST"
}

restic_env() {
  [ -f "$secrets/backup/restic.env" ] && [ -f "$secrets/backup/password" ] || return 1
  set -a; . "$secrets/backup/restic.env"; set +a
  export RESTIC_PASSWORD_FILE="$secrets/backup/password"
  command -v restic >/dev/null || { echo "error: restic is not installed" >&2; exit 1; }
}

# The board's banner reads this (D-58). Keeps the last success across failures.
write_status() { # state [error]
  mkdir -p "$(dirname "$status_file")"
  node -e '
    const fs = require("node:fs");
    const [file, state, line, snapshot] = process.argv.slice(1);
    let error = line;
    try { error = JSON.parse(line).message ?? line; } catch {}
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const at = new Date().toISOString();
    const next = { state, at, lastSuccess: state === "ok" ? at : prev.lastSuccess ?? null, snapshot: state === "ok" ? snapshot : prev.snapshot ?? null };
    if (error) next.error = error.slice(0, 300);
    fs.writeFileSync(file + ".tmp", JSON.stringify(next) + "\n");
    fs.renameSync(file + ".tmp", file);
  ' "$status_file" "$1" "${2:-}" "${3:-}"
}

# Runs at most once per period: due <name> <seconds>.
due() {
  local stamp="$cache/$1.last"
  [ ! -f "$stamp" ] || [ $(( $(date +%s) - $(stat -c %Y "$stamp") )) -ge "$2" ]
}

case "$mode" in
  archive)
    out_dir="${1:-$repo/backups}"
    mkdir -p "$out_dir"
    archive="$out_dir/pennyworth-$(date +%Y%m%d-%H%M%S).tar.gz"
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    echo "Backing up to $archive"
    stage "$work/stage"
    sed 's/^/  /' "$work/stage/MANIFEST"
    (umask 077; tar -C "$work/stage" -czf "$archive" .)
    echo "Done: $archive ($(du -h "$archive" | cut -f1))"
    ;;

  init)
    restic_env || { echo "error: create $secrets/backup/restic.env and $secrets/backup/password first (see docs/DECISIONS.md D-58)" >&2; exit 1; }
    if restic cat config >/dev/null 2>&1; then
      echo "The repository already exists: $RESTIC_REPOSITORY"
    else
      restic init
    fi
    ;;

  offsite)
    mkdir -p "$cache"
    exec 9>"$cache/lock"
    flock -n 9 || { echo "another backup is running"; exit 0; }
    if ! restic_env; then
      write_status missing "no $secrets/backup/restic.env or password"
      echo "Off-machine backups aren't set up: no $secrets/backup/restic.env or password"
      exit 0
    fi
    log="$cache/last.log"
    trap 'rc=$?; [ $rc -eq 0 ] || write_status failed "$(tail -1 "$log" 2>/dev/null)"; exit $rc' EXIT
    {
      stage "$cache/stage"
      restic backup --host pennyworth --tag pennyworth --json --quiet "$cache/stage" | tail -1 > "$cache/summary.json"
      if due prune 86400; then
        restic forget --host pennyworth --tag pennyworth --prune \
          --keep-hourly 48 --keep-daily 30 --keep-weekly 26 --keep-monthly 24
        touch "$cache/prune.last"
      fi
      if due check 604800; then
        restic check --read-data-subset=5%
        touch "$cache/check.last"
      fi
    } > "$log" 2>&1
    snapshot="$(node -e 'const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); console.log(s.snapshot_id?.slice(0, 8) ?? "")' "$cache/summary.json")"
    added="$(node -e 'const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); console.log((s.data_added / 1e6).toFixed(1))' "$cache/summary.json")"
    write_status ok "" "$snapshot"
    echo "Snapshot $snapshot ($added MB uploaded)"
    ;;

  verify)
    restic_env || { echo "error: off-machine backups aren't set up" >&2; exit 1; }
    id="${1:-latest}"
    work="$(mktemp -d)"
    container="pennyworth-verify-$$"
    trap 'docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
    restic restore "$id" --target "$work" --quiet
    root="$(dirname "$(find "$work" -name MANIFEST -path '*/stage/MANIFEST' | head -1)")"
    [ -f "$root/MANIFEST" ] || { echo "error: snapshot $id has no Pennyworth backup" >&2; exit 1; }
    echo "Snapshot $id:"
    sed 's/^/  /' "$root/MANIFEST"
    for db in board/board.sqlite ops-mcp/state.sqlite runner/state.sqlite; do
      [ -f "$root/$db" ] || { echo "  MISSING $db"; exit 1; }
      result="$(node --disable-warning=ExperimentalWarning -e '
        const { DatabaseSync } = require("node:sqlite");
        console.log(new DatabaseSync(process.argv[1], { readOnly: true }).prepare("PRAGMA integrity_check").get().integrity_check);
      ' "$root/$db")"
      [ "$result" = ok ] || { echo "  FAIL $db: $result"; exit 1; }
      echo "  ok   $db"
    done
    [ -f "$root/paperclip/instance/secrets/master.key" ] || { echo "  MISSING Paperclip's secrets master key"; exit 1; }
    echo "  ok   Paperclip secrets master key"
    # Load the dump into a throwaway Postgres (no network) the way a restore would.
    docker run -d --name "$container" --network none -e POSTGRES_PASSWORD=verify \
      -v "$root/paperclip/paperclip.sql:/dump.sql:ro" postgres:18-alpine >/dev/null
    for _ in $(seq 60); do docker exec "$container" pg_isready -U postgres -q 2>/dev/null && break; sleep 1; done
    docker exec "$container" psql -U postgres -q -v ON_ERROR_STOP=1 -f /dump.sql >/dev/null
    issues="$(docker exec "$container" psql -U postgres -tAc 'select count(*) from issues')"
    comments="$(docker exec "$container" psql -U postgres -tAc 'select count(*) from issue_comments')"
    echo "  ok   Paperclip database loads: $issues tasks, $comments comments"
    ;;
esac
