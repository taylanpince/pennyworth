#!/usr/bin/env bash
# Read-only health check of the whole stack. Creates nothing anywhere.
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo" || exit 1
env_file="${PENNYWORTH_ENV_FILE:-.env}"
[ -f "$env_file" ] && { set -a; . "$env_file"; set +a; }
dc() { docker compose --env-file "$env_file" "$@"; }

fails=0
check() { # name, command...
  local name="$1"; shift
  if out="$("$@" 2>&1)"; then
    printf '  ok    %s\n' "$name"
  else
    printf '  FAIL  %s  %s\n' "$name" "$(echo "$out" | tail -1 | cut -c1-160)"
    fails=$((fails + 1))
  fi
}

echo "Pennyworth health"
check "paperclip http (127.0.0.1:3100)" sh -c 'curl -fsS --max-time 5 http://127.0.0.1:3100/api/health | grep -q "\"status\":\"ok\""'
check "paperclip bootstrap (account claimed)" sh -c 'curl -fsS --max-time 5 http://127.0.0.1:3100/api/health | grep -q "\"bootstrapStatus\":\"ready\""'

# ops-mcp is only reachable inside the compose network; ask Paperclip's container.
ops_health="$(dc exec -T paperclip node -e "fetch('http://ops-mcp:8080/healthz').then(r=>r.text()).then(t=>console.log(t)).catch(e=>{console.log(JSON.stringify({error:e.message}));process.exit(1)})" 2>/dev/null)"
check "ops-mcp reachable" test -n "$ops_health"
for k in sqlite_writable transcripts_readable vault_available vault_writable paperclip_api; do
  check "ops-mcp $k" sh -c "echo '$ops_health' | grep -q '\"$k\":{\"ok\":true'"
done

check "codex logged in (ChatGPT)" dc exec -T -u node paperclip test -s /paperclip/.codex/auth.json

g_health="$(dc exec -T paperclip node -e "fetch('http://google-workspace-mcp:8081/healthz').then(r=>r.text()).then(console.log).catch(e=>{console.log(e.message);process.exit(1)})" 2>/dev/null)"
if echo "$g_health" | grep -q '"ok":true'; then
  # Harmless read: list today's events (count only).
  token="$(cat "${PENNYWORTH_SECRETS_DIR:-/nonexistent}/google_mcp_token" 2>/dev/null)"
  dc cp scripts/dev/mcp-call.mjs paperclip:/tmp/mcp-call.mjs >/dev/null 2>&1
  check "gmail read (1 message)" sh -c "docker compose --env-file '$env_file' exec -T paperclip node /tmp/mcp-call.mjs http://google-workspace-mcp:8081/mcp gmail_search '{\"query\":\"in:inbox\",\"max_results\":1}' '$token' >/dev/null"
  check "google calendar read" sh -c "docker compose --env-file '$env_file' exec -T paperclip node /tmp/mcp-call.mjs http://google-workspace-mcp:8081/mcp calendar_list_events '{\"start\":\"$(date -u +%Y-%m-%dT00:00:00Z)\",\"end\":\"$(date -u +%Y-%m-%dT23:59:59Z)\",\"max_results\":5}' '$token' >/dev/null"
else
  printf '  skip  google workspace (not connected: %s)\n' "$(echo "$g_health" | cut -c1-80)"
fi

dc cp scripts/dev/mcp-call.mjs paperclip:/tmp/mcp-call.mjs >/dev/null 2>&1
s_health="$(dc exec -T paperclip node -e "fetch('http://slack-mcp:8082/healthz').then(r=>r.text()).then(console.log).catch(e=>{console.log(e.message);process.exit(1)})" 2>/dev/null)"
if echo "$s_health" | grep -q '"ok":true'; then
  stoken="$(cat "${PENNYWORTH_SECRETS_DIR:-/nonexistent}/slack_mcp_token" 2>/dev/null)"
  check "slack read (own profile)" sh -c "docker compose --env-file '$env_file' exec -T paperclip node /tmp/mcp-call.mjs http://slack-mcp:8082/mcp slack_read_user_profile '{\"response_format\":\"concise\"}' '$stoken' >/dev/null"
else
  printf '  skip  slack (not connected: %s)\n' "$(echo "$s_health" | cut -c1-80)"
fi

check "watcher webhook configured" test -s "${PENNYWORTH_SECRETS_DIR:-/nonexistent}/meeting_webhook_url"
if systemctl --user list-unit-files pennyworth-transcripts.path >/dev/null 2>&1; then
  check "transcript watcher active" systemctl --user is-active --quiet pennyworth-transcripts.path
else
  printf '  skip  transcript watcher (not installed; see nix/README.md)\n'
fi

echo
[ "$fails" -eq 0 ] && echo "All checks passed." || { echo "$fails check(s) failed."; exit 1; }
