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
  # Every connected account, not just the one the reads above happened to use (D-36).
  atoken="$(cat "${PENNYWORTH_SECRETS_DIR:-/nonexistent}/google_auth_token" 2>/dev/null)"
  if [ -n "$atoken" ]; then
    accounts="$(dc exec -T -e T="$atoken" paperclip node -e "fetch('http://google-workspace-mcp:8081/auth/status',{headers:{authorization:'Bearer '+process.env.T}}).then(r=>r.json()).then(s=>{for(const a of s.accounts)console.log(a.email+' '+a.state)}).catch(e=>console.log('? '+e.message))" 2>/dev/null)"
    while read -r email state; do
      [ -n "$email" ] || continue
      check "google sign-in $email" sh -c "[ '$state' = ok ] || { echo '$state: reconnect it from the board (http://127.0.0.1:3120) or run scripts/google-auth.sh --email $email'; exit 1; }"
    done <<< "$accounts"
  fi
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

t_health="$(dc exec -T paperclip node -e "fetch('http://telegram-mcp:8083/healthz').then(r=>r.text()).then(console.log).catch(e=>{console.log(e.message);process.exit(1)})" 2>/dev/null)"
if echo "$t_health" | grep -q '"ok":true'; then
  ttoken="$(cat "${PENNYWORTH_SECRETS_DIR:-/nonexistent}/telegram_mcp_token" 2>/dev/null)"
  check "telegram read (chats)" sh -c "docker compose --env-file '$env_file' exec -T paperclip node /tmp/mcp-call.mjs http://telegram-mcp:8083/mcp list_allowed_chats '{}' '$ttoken' >/dev/null"
  # The sweep catches up every few minutes; an old one means the session is stuck (D-37).
  check "telegram sweep (last 10 minutes)" sh -c "echo '$t_health' | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const h=JSON.parse(s);const age=Date.now()-Date.parse(h.last_scan_at);if(!(age<600000)){console.log('last sweep '+h.last_scan_at);process.exit(1)}})\""
elif echo "$t_health" | grep -q '"state":"ended"'; then
  check "telegram session" sh -c "echo 'Telegram ended the session: reconnect from the board (http://127.0.0.1:3120)'; exit 1"
else
  printf '  skip  telegram (not connected: %s)\n' "$(echo "$t_health" | cut -c1-80)"
fi

p_health="$(dc exec -T paperclip node -e "fetch('http://primer-mcp:8084/healthz').then(r=>r.text()).then(console.log).catch(e=>{console.log(e.message);process.exit(1)})" 2>/dev/null)"
if echo "$p_health" | grep -q '"ok":true'; then
  ptoken="$(cat "${PENNYWORTH_SECRETS_DIR:-/nonexistent}/primer_mcp_token" 2>/dev/null)"
  check "primer (whoami)" sh -c "docker compose --env-file '$env_file' exec -T paperclip node /tmp/mcp-call.mjs http://primer-mcp:8084/mcp primer_whoami '{}' '$ptoken' >/dev/null"
  # The Engineer jobs' read-only endpoint on loopback (D-40).
  check "primer (runner, read-only)" sh -c "curl -fsS -X POST http://127.0.0.1:3123/mcp/read -H 'Authorization: Bearer $ptoken' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' | grep -q primer_get_document"
else
  printf '  skip  primer (not connected: %s)\n' "$(echo "$p_health" | cut -c1-80)"
fi

gl_health="$(dc exec -T paperclip node -e "fetch('http://glean-mcp:8085/healthz').then(r=>r.text()).then(console.log).catch(e=>{console.log(e.message);process.exit(1)})" 2>/dev/null)"
if echo "$gl_health" | grep -q '"ok":true'; then
  # Listing tools signs in to Glean without running a search.
  gltoken="$(cat "${PENNYWORTH_SECRETS_DIR:-/nonexistent}/glean_mcp_token" 2>/dev/null)"
  check "glean (read tools)" sh -c "docker compose --env-file '$env_file' exec -T paperclip node /tmp/mcp-call.mjs http://glean-mcp:8085/mcp --list '$gltoken' | grep -q '^search\b'"
elif [ -n "${GLEAN_MCP_URL:-}" ]; then
  # Set up but not signed in, or Glean stopped accepting the sign-in (D-38).
  check "glean sign-in" sh -c "echo '$(echo "$gl_health" | cut -c1-140)' | grep -o '\"detail\":\"[^\"]*' | cut -d'\"' -f4 | grep . || echo 'glean-mcp unreachable'; exit 1"
else
  printf '  skip  glean (GLEAN_MCP_URL not set)\n'
fi

gh_health="$(dc exec -T paperclip node -e "fetch('http://github-mcp:8086/healthz').then(r=>r.text()).then(console.log).catch(e=>{console.log(e.message);process.exit(1)})" 2>/dev/null)"
if echo "$gh_health" | grep -q '"ok":true'; then
  ghtoken="$(cat "${PENNYWORTH_SECRETS_DIR:-/nonexistent}/github_mcp_token" 2>/dev/null)"
  check "github (whoami)" sh -c "docker compose --env-file '$env_file' exec -T paperclip node /tmp/mcp-call.mjs http://github-mcp:8086/mcp github_whoami '{}' '$ghtoken' | grep -q '\"login\"' || { echo 'GitHub rejected the token: run scripts/github-auth.sh'; exit 1; }"
else
  printf '  skip  github (not connected: %s)\n' "$(echo "$gh_health" | cut -c1-80)"
fi

if [ -n "${KNOWLEDGE_BASES:-}" ]; then
  check "ops-mcp knowledge bases" sh -c "echo '$ops_health' | grep -q '\"knowledge_bases\":{\"ok\":true' || { echo 'none mounted: re-run scripts/bootstrap.sh and recreate ops-mcp'; exit 1; }"
fi

check "board (127.0.0.1:3120)" sh -c 'curl -fsS --max-time 5 http://127.0.0.1:3120/healthz | grep -q ok && curl -fsS --max-time 10 http://127.0.0.1:3120/api/board | grep -q "\"buckets\""'

check "watcher webhook configured" test -s "${PENNYWORTH_SECRETS_DIR:-/nonexistent}/meeting_webhook_url"
if systemctl --user list-unit-files pennyworth-transcripts.path >/dev/null 2>&1; then
  check "transcript watcher active" systemctl --user is-active --quiet pennyworth-transcripts.path
else
  printf '  skip  transcript watcher (not installed; see nix/README.md)\n'
fi

echo
[ "$fails" -eq 0 ] && echo "All checks passed." || { echo "$fails check(s) failed."; exit 1; }
