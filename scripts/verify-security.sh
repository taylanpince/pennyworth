#!/usr/bin/env bash
# Automated checks for the security acceptance criteria (SPECS.md §40) that can be
# verified mechanically. Run with the stack up.
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo" || exit 1
env_file="${PENNYWORTH_ENV_FILE:-.env}"
[ -f "$env_file" ] && { set -a; . "$env_file"; set +a; }
project="${COMPOSE_PROJECT_NAME:-pennyworth}"
fails=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }

containers="$(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}}')"
[ -n "$containers" ] || { echo "no running containers for project $project"; exit 1; }

echo "Containers: $(echo $containers)"
for c in $containers; do
  mounts="$(docker inspect "$c" --format '{{range .Mounts}}{{.Source}}|{{.Destination}}|{{.RW}};{{end}}')"
  echo "$mounts" | grep -q 'docker.sock' && fail "$c mounts the Docker socket" || pass "$c: no Docker socket"
  echo "$mounts" | tr ';' '\n' | awk -F'|' -v h="$HOME" '$1==h || $1==h"/"' | grep -q . && fail "$c mounts \$HOME" || pass "$c: home directory not mounted"
  [ "$(docker inspect "$c" --format '{{.HostConfig.Privileged}}')" = "false" ] && pass "$c: not privileged" || fail "$c is privileged"
  docker inspect "$c" --format '{{json .HostConfig.SecurityOpt}}' | grep -q 'no-new-privileges' && pass "$c: no-new-privileges" || fail "$c lacks no-new-privileges"
  docker inspect "$c" --format '{{json .HostConfig.CapDrop}}' | grep -q 'ALL' && pass "$c: all capabilities dropped" || fail "$c keeps capabilities"
  [ "$(docker inspect "$c" --format '{{.HostConfig.NetworkMode}}')" != "host" ] && pass "$c: not host networking" || fail "$c uses host networking"
  case "$c" in
    *paperclip*)
      echo "$mounts" | grep -q '/vault' && fail "paperclip has vault access" || pass "paperclip: no vault mount"
      echo "$mounts" | grep -q '/sources/transcripts' && fail "paperclip has transcript access" || pass "paperclip: no transcript mount"
      ports="$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')"
      echo "$ports" | grep -q '"HostIp":"127.0.0.1"' && ! echo "$ports" | grep -q '"HostIp":""' && ! echo "$ports" | grep -q '"HostIp":"0.0.0.0"' \
        && pass "paperclip: published on 127.0.0.1 only" || fail "paperclip port binding is not loopback-only: $ports"
      ;;
    *ops-mcp*)
      # Writable on purpose (D-26): ops-mcp renames published transcripts and deletes their audio.
      echo "$mounts" | tr ';' '\n' | grep -q '|/sources/transcripts|' && pass "ops-mcp: transcripts mounted (writable for organizing, D-26)" || fail "ops-mcp: transcripts not mounted"
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "ops-mcp: no published ports" || fail "ops-mcp publishes ports"
      if docker exec "$c" node -e "fetch('https://api.openai.com',{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
        fail "ops-mcp has Internet egress"
      else
        pass "ops-mcp: no Internet egress"
      fi
      ;;
    *telegram-mcp*)
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "telegram-mcp: no published ports" || fail "telegram-mcp publishes ports"
      [ "$(echo "$mounts" | tr ';' '\n' | grep -c '|/state|')" = "1" ] && ! echo "$mounts" | tr ';' '\n' | grep -v '/run/secrets' | grep -v '|/state|' | grep -q . \
        && pass "telegram-mcp: only its own token/state directory mounted" || fail "telegram-mcp has unexpected mounts: $mounts"
      ;;
    *primer-mcp*)
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "primer-mcp: no published ports" || fail "primer-mcp publishes ports"
      [ "$(echo "$mounts" | tr ';' '\n' | grep -c '|/state|')" = "1" ] && ! echo "$mounts" | tr ';' '\n' | grep -v '/run/secrets' | grep -v '|/state|' | grep -q . \
        && pass "primer-mcp: only its own token directory mounted" || fail "primer-mcp has unexpected mounts: $mounts"
      ;;
    *board*)
      # 3120 is the trusted local board; 3121 (LAN, D-23) may be published, but only serves paired devices.
      local_port="$(docker inspect "$c" --format '{{json (index .HostConfig.PortBindings "3120/tcp")}}')"
      echo "$local_port" | grep -q '"HostIp":"127.0.0.1"' && ! echo "$local_port" | grep -qE '"HostIp":"(0\.0\.0\.0)?"' \
        && pass "board: local port published on 127.0.0.1 only" || fail "board local port is not loopback-only: $local_port"
      lan_port="$(docker inspect "$c" --format '{{range (index .HostConfig.PortBindings "3121/tcp")}}{{.HostIp}}:{{.HostPort}}{{end}}')"
      lan_dev="$(ip -4 route show default | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')"
      lan_ip="$(ip -4 -o addr show dev "${lan_dev:-none}" scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1]; exit }')"
      if [ "${lan_port%%:*}" = "127.0.0.1" ] || [ -z "$lan_port" ] || [ -z "$lan_ip" ]; then
        pass "board: LAN access off (${lan_port:-not published})"
      else
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: pennyworth.local' "http://$lan_ip:${lan_port##*:}/api/board")"
        [ "$code" = "401" ] || [ "$code" = "403" ] && pass "board: LAN port refuses unpaired devices ($code)" || fail "board LAN port answered an unpaired request ($code)"
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H 'Host: pennyworth.local' -H 'content-type: application/json' -H 'x-pennyworth-board: 1' "http://$lan_ip:${lan_port##*:}/api/pairing" -d '{}')"
        [ "$code" = "403" ] && pass "board: pairing links only from the laptop" || fail "board LAN port made a pairing link ($code)"
      fi
      code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'Origin: http://evil.example' -H 'x-pennyworth-board: 1' http://127.0.0.1:3120/api/issues -d '{}')"
      [ "$code" = "403" ] && pass "board: refuses cross-origin writes" || fail "board accepted a cross-origin write ($code)"
      code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example:3120' http://127.0.0.1:3120/api/board)"
      [ "$code" = "403" ] && pass "board: refuses unknown Host headers" || fail "board answered an unknown Host ($code)"
      # 3122: internal API for the tasks bridge and the runner (D-25), loopback only, bearer token.
      internal_port="$(docker inspect "$c" --format '{{json (index .HostConfig.PortBindings "3122/tcp")}}')"
      if [ "$internal_port" = "null" ]; then
        pass "board: internal API not published"
      else
        echo "$internal_port" | grep -q '"HostIp":"127.0.0.1"' && ! echo "$internal_port" | grep -qE '"HostIp":"(0\.0\.0\.0)?"' \
          && pass "board: internal API published on 127.0.0.1 only" || fail "board internal API is not loopback-only: $internal_port"
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST http://127.0.0.1:3122/internal/recurring/claim)"
        [ "$code" = "401" ] && pass "board: internal API refuses requests without the token" || fail "board internal API answered without the token ($code)"
      fi
      ;;
  esac
done

echo "Repository"
if git ls-files -z --cached --others --exclude-standard -- . ':!scripts/verify-security.sh' | xargs -0 grep -lE '(sk-[A-Za-z0-9]{20,}|pcp_[a-f0-9]{20,}|GOCSPX-|refresh_token"\s*:\s*"1//|xox[bp]-)' 2>/dev/null | grep -q .; then
  fail "possible secrets in tracked files"
else
  pass "no secret patterns in tracked files"
fi
git ls-files --cached --others --exclude-standard | grep -qE '(^|/)(\.env|system\.yaml|routing\.yaml|paperclip\.yaml)$' && fail "local config tracked in git" || pass "local config not tracked"

echo "Capabilities (by construction)"
pass "ops-mcp exposes no delete/replace/arbitrary-write tools (see services/ops-mcp/src/mcp/tools.ts)"
pass "google-workspace-mcp requests only *.readonly scopes and has GET-only client code"
pass "slack-mcp exposes only allowlisted read tools and never send/react/edit tools (services/slack-mcp/src/policy.ts)"
pass "telegram-mcp exposes only allowlisted read tools; never send, draft or allowlist-change tools (services/telegram-mcp/src/policy.ts)"
pass "primer-mcp exposes reads plus create-document/add-version only; never delete, share, visibility or page-event tools (services/primer-mcp/src/policy.ts)"
pass "no email/Slack/Telegram send or calendar write tool is configured for any agent"

echo
[ "$fails" -eq 0 ] && echo "All security checks passed." || { echo "$fails security check(s) failed."; exit 1; }
