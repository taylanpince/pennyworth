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
      ! echo "$mounts" | tr ';' '\n' | grep -q '|/knowledge/[^|]*|true$' && pass "ops-mcp: knowledge bases mounted read-only" || fail "ops-mcp: a knowledge base is mounted writable"
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
        && pass "telegram-mcp: only its own session/state directory mounted" || fail "telegram-mcp has unexpected mounts: $mounts"
      docker exec "$c" sh -c 'for f in /state/session /state/api.json; do [ ! -e "$f" ] || [ "$(stat -c %a "$f")" = 600 ] || exit 1; done' \
        && pass "telegram-mcp: session and api.json are 0600" || fail "telegram-mcp: session or api.json is readable by others"
      ;;
    *primer-mcp*)
      # Loopback only, for the runner's Engineer jobs (D-40); bearer token required.
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = '{"8084/tcp":[{"HostIp":"127.0.0.1","HostPort":"3123"}]}' ] \
        && pass "primer-mcp: published on 127.0.0.1:3123 only" || fail "primer-mcp ports are not loopback 3123 only"
      [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3123/mcp/read)" = "401" ] \
        && pass "primer-mcp: loopback endpoint requires the token" || fail "primer-mcp: loopback endpoint answers without the token"
      [ "$(echo "$mounts" | tr ';' '\n' | grep -c '|/state|')" = "1" ] && ! echo "$mounts" | tr ';' '\n' | grep -v '/run/secrets' | grep -v '|/state|' | grep -q . \
        && pass "primer-mcp: only its own token directory mounted" || fail "primer-mcp has unexpected mounts: $mounts"
      ;;
    *glean-mcp*)
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "glean-mcp: no published ports" || fail "glean-mcp publishes ports"
      [ "$(echo "$mounts" | tr ';' '\n' | grep -c '|/state|')" = "1" ] && ! echo "$mounts" | tr ';' '\n' | grep -v '/run/secrets' | grep -v '|/state|' | grep -q . \
        && pass "glean-mcp: only its own token directory mounted" || fail "glean-mcp has unexpected mounts: $mounts"
      ;;
    *grafana-mcp*)
      # Loopback only, for the runner's Engineer jobs; bearer token required.
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = '{"8087/tcp":[{"HostIp":"127.0.0.1","HostPort":"3124"}]}' ] \
        && pass "grafana-mcp: published on 127.0.0.1:3124 only" || fail "grafana-mcp ports are not loopback 3124 only"
      [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3124/mcp)" = "401" ] \
        && pass "grafana-mcp: loopback endpoint requires the token" || fail "grafana-mcp: loopback endpoint answers without the token"
      [ "$(echo "$mounts" | tr ';' '\n' | grep -c '|/state|')" = "1" ] && ! echo "$mounts" | tr ';' '\n' | grep -v '/run/secrets' | grep -v '|/state|' | grep -q . \
        && pass "grafana-mcp: only its own token directory mounted" || fail "grafana-mcp has unexpected mounts: $mounts"
      ;;
    *github-mcp*)
      [ "$(docker inspect "$c" --format '{{json .HostConfig.PortBindings}}')" = "{}" ] && pass "github-mcp: no published ports" || fail "github-mcp publishes ports"
      ! echo "$mounts" | tr ';' '\n' | grep -v '/run/secrets' | grep -q . \
        && pass "github-mcp: only its secrets mounted" || fail "github-mcp has unexpected mounts: $mounts"
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
# Slack: reads, plus saving a draft by exact name with fixed arguments; the name guard refuses every other write (D-46).
grep -qF 'export const DRAFT_TOOL = "slack_send_message_draft";' services/slack-mcp/src/policy.ts && grep -qF 'export const DRAFT_ARGS = ["channel_id", "message", "thread_ts"];' services/slack-mcp/src/policy.ts \
  && grep -qF 'upstreamArgs(name,' services/slack-mcp/src/main.ts && grep -qE '^const NEVER = /\(send\|post\|schedule' services/slack-mcp/src/policy.ts \
  && pass "slack-mcp exposes allowlisted read tools and the draft tool only; never send/react/edit tools (services/slack-mcp/src/policy.ts)" || fail "slack-mcp: write policy changed"
for a in config/paperclip.yaml config/paperclip.example.yaml; do
  [ -f "$a" ] || continue
  drafters="$(awk '/^  [a-z-]+:$/{agent=$1} /slack_send_message_draft/{print agent}' "$a" | sort -u | tr '\n' ' ')"
  [ "$drafters" = "assistant: " ] && pass "$a: only the Assistant can save Slack drafts" || fail "$a: Slack drafts allowed for: $drafters"
done
# The session can do anything the account can: every request goes through the guard, which allows reads only (D-37).
grep -q 'guard(client, allowed' services/telegram-mcp/src/reader.ts && grep -q 'readingClient(' services/telegram-mcp/src/main.ts \
  && pass "telegram-mcp: the reading client is wrapped in the request guard" || fail "telegram-mcp: request guard not wired in"
bad_reads="$(sed -n '/^export const READ_REQUESTS/,/^\]);/p' services/telegram-mcp/src/guard.ts | grep -oE '"[a-zA-Z]+\.[A-Za-z]+"' | tr -d '"' | grep -Ev '^[a-z]+\.(Get|Search)' ; sed -n '/^export const READ_REQUESTS/,/^\]);/p' services/telegram-mcp/src/guard.ts | grep -oE '"[a-zA-Z]+\.[A-Za-z]+"' | tr -d '"' | grep -E '^(auth|account|contacts|upload|payments)\.|Read|Send|Draft|Save|Views' || true)"
[ -z "$bad_reads" ] && pass "telegram-mcp: request allowlist holds only Get/Search reads (no send, mark-read, account or auth)" || fail "telegram-mcp: non-read requests allowed: $bad_reads"
pass "primer-mcp exposes reads plus create-document/add-version only; never delete, share, visibility or page-event tools (services/primer-mcp/src/policy.ts)"
# Glean: reads only, and the name guard refuses write-like tools even if allowlisted (D-38).
glean_tools="$(sed -n 's/^export const READ_TOOLS = \[\(.*\)\];/\1/p' services/glean-mcp/src/policy.ts | tr -d '" ' | tr ',' '\n')"
bad_glean="$(echo "$glean_tools" | grep -Ev '^(search|read_document|employee_search|meeting_lookup|code_search|chat)$' || true)"
[ -n "$glean_tools" ] && [ -z "$bad_glean" ] && pass "glean-mcp exposes only search/read tools (services/glean-mcp/src/policy.ts)" || fail "glean-mcp: unexpected tools allowed: $bad_glean"
# Grafana: signed in with read and query scopes only, and only read tools on the list.
grafana_scopes="$(sed -n 's/^export const SCOPES = \[\(.*\)\];/\1/p' services/grafana-mcp/src/policy.ts | tr -d '" ')"
[ "$grafana_scopes" = "grafana:read,grafana:query" ] && pass "grafana-mcp asks for grafana:read and grafana:query only, never write (services/grafana-mcp/src/policy.ts)" || fail "grafana-mcp: unexpected scopes: $grafana_scopes"
grafana_tools="$(sed -n '/^export const READ_TOOLS = \[/,/^\];/p' services/grafana-mcp/src/policy.ts | grep -oE '^  "[a-z0-9_]+"' | tr -d '" ')"
bad_grafana="$(echo "$grafana_tools" | grep -Ev '^(query|list|get|search|analyze|diff|check|run_panel_query$|alerting_(rules|silences)_read$)' ; echo "$grafana_tools" | grep -E 'creat|add_|update|delete|remove|manage|exec|write|edit|patch|send|post|resolve|investigation|assistant|handler|gcx|sql' || true)"
[ -n "$grafana_tools" ] && [ -z "$bad_grafana" ] && pass "grafana-mcp exposes only read/query tools (services/grafana-mcp/src/policy.ts)" || fail "grafana-mcp: unexpected tools allowed: $bad_grafana"
# Engineer jobs' Google Cloud token (D-48): per-API read-only scopes only. cloud-platform.read-only and
# devstorage.read_only are accepted for writes by some APIs; userinfo.email would let kubectl act.
gcp_scopes="$(sed -n '/^export const READ_SCOPES = \[/,/^\];/p' services/runner/src/gcp.mjs | grep -oE '^  "https://www.googleapis.com/auth/[a-z._-]+"' | sed 's|.*/auth/||; s/"//')"
bad_gcp="$(echo "$gcp_scopes" | grep -Ev '^(logging\.read|monitoring\.read|compute\.readonly|container\.read-only|run\.readonly|redis\.read-only|ndev\.clouddns\.readonly)$' || true)"
[ -n "$gcp_scopes" ] && [ -z "$bad_gcp" ] && pass "runner: Google Cloud tokens for jobs are per-API read-only scopes (services/runner/src/gcp.mjs)" || fail "runner: unexpected Google Cloud scopes for jobs: $bad_gcp"
grep -q '"bwrap", "--dev-bind", "/", "/"' services/runner/src/engines.mjs && grep -q 'join(homedir(), ".config/gcloud")' services/runner/src/config.mjs \
  && pass "runner: jobs can't read the gcloud sign-ins (bwrap tmpfs)" || fail "runner: the gcloud sign-ins aren't hidden from jobs"
# GitHub: the user's gh token can push and delete; the guard allows fixed reads plus issue comments, new issues,
# fixed GraphQL documents whose only mutations add an issue to a project and set its status (D-39, D-42), and
# issue state/labels/assignees, pull request reviews and failed-job re-runs (D-46).
gh_routes="$(sed -n '/^export const ROUTES/,/^\];/p' services/github-mcp/src/github.ts | grep '^  { method:')"
bad_gh="$(echo "$gh_routes" | grep -v '{ method: "GET", path: ' | grep -vxF \
  -e '  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/comments$`) },' \
  -e '  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/issues$`) },' \
  -e '  { method: "POST", path: /^\/graphql$/ },' \
  -e '  { method: "PATCH", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}$`) },' \
  -e '  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/labels$`) },' \
  -e '  { method: "DELETE", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/labels/${LABEL}$`) },' \
  -e '  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/assignees$`) },' \
  -e '  { method: "DELETE", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/assignees$`) },' \
  -e '  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}/reviews$`) },' \
  -e '  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/actions/runs/${RUN}/rerun-failed-jobs$`) },' || true)"
[ -n "$gh_routes" ] && [ -z "$bad_gh" ] && grep -q 'guard(method, path, opts.body)' services/github-mcp/src/github.ts && [ "$(grep -c 'fetchImpl(' services/github-mcp/src/github.ts)" = 1 ] \
  && grep -qF '{ method: "PATCH", path: /\/issues\/[0-9]+$/, fields: ["state", "state_reason"] },' services/github-mcp/src/github.ts \
  && pass "github-mcp: every request goes through the guard; the only writes are issue comments, new issues, issue state/labels/assignees, reviews, failed-job re-runs and GraphQL (services/github-mcp/src/github.ts)" || fail "github-mcp: unexpected GitHub requests allowed: $bad_gh"
gh_mutations="$(sed -n '/^export const GRAPHQL/,/^} as const;/p' services/github-mcp/src/github.ts | grep -oE 'mutation\([^)]*\) \{ [A-Za-z0-9]+' | awk '{print $NF}' | sort -u | tr '\n' ' ')"
[ "$gh_mutations" = "addProjectV2ItemById updateProjectV2ItemFieldValue " ] && grep -q 'GRAPHQL_DOCS.has(' services/github-mcp/src/github.ts \
  && pass "github-mcp: GraphQL limited to fixed documents whose only mutations add an issue to a project and set its status" || fail "github-mcp: unexpected GraphQL mutations: $gh_mutations"
# The runner merges the PRs a task lists (D-46): its only GitHub writes are merge and update-branch (REST, checked
# against merges.WRITES) and marking a draft ready (one fixed GraphQL mutation). Pushes and draft PRs stay on the exact word.
merge_writes="$(sed -n '/^export const WRITES/,/^\];/p' services/runner/src/merges.mjs | grep -oE 'method: "[A-Z]+", path: /[^ ]+/' | tr '\n' ' ')"
[ "$merge_writes" = 'method: "PUT", path: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/merge$/ method: "PUT", path: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/update-branch$/ ' ] \
  && [ "$(grep -o 'mutation([^)]*) { [A-Za-z]*' services/runner/src/merges.mjs | awk '{print $NF}' | tr '\n' ' ')" = "markPullRequestReadyForReview " ] \
  && [ "$(grep -c '"-X"' services/runner/src/main.mjs)" = 1 ] && grep -q 'merges.WRITES.some(' services/runner/src/main.mjs \
  && pass "runner: merge queue writes only merges, branch updates and ready-for-review (services/runner/src/merges.mjs)" || fail "runner: unexpected merge-queue writes: $merge_writes"
# The Engineer's own tools (docs/design/conversational-engineers.md): a fixed command list on the per-run
# loopback endpoint, every write checked against the user's words, and the check given nothing else.
tools="$(grep -oE '^export const TOOLS = \[[^]]*\]' services/runner/src/repohelper.mjs)"
[ "$tools" = 'export const TOOLS = ["repo", "status", "push", "pr", "merge"]' ] \
  && grep -q 'check: (ordered) => allowWrite(ctx, command,' services/runner/src/main.mjs \
  && [ "$(awk '/^async function agentMerge/,/^}/' services/runner/src/main.mjs | grep -n 'await allowWrite(ctx, "merge"' | cut -d: -f1)" -lt "$(awk '/^async function agentMerge/,/^}/' services/runner/src/main.mjs | grep -n 'ctx.merge = ' | cut -d: -f1)" ] \
  && grep -q '^export function authorizePrompt({ user, action, earlier = \[\], recent = \[\], lastReply = "" })' services/runner/src/authorize.mjs \
  && pass "runner: the Engineer's push, pr and merge are checked against the user's words only (services/runner/src/authorize.mjs)" || fail "runner: the Engineer's tools or their check changed: $tools"
pass "no email/Slack/Telegram send or calendar write tool is configured for any agent"

echo
[ "$fails" -eq 0 ] && echo "All security checks passed." || { echo "$fails security check(s) failed."; exit 1; }
