# AGENTS.md

Guidance for coding agents working on **Pennyworth**, a personal executive assistant built on Paperclip. Read `README.md` for the user-facing overview, `docs/SPECS.md` for the original spec, and `docs/DECISIONS.md` (D-1 to D-23) for why things are the way they are. This file covers how to work on the system and the traps already found.

## System map

```text
host (NixOS, user taylan)
├── pennyworth-runner (systemd --user, node, runs AS THE USER)   services/runner/
│     polls Paperclip: engineer tasks → Codex/Claude Code/OpenRouter jobs in ~/pennyworth worktrees
│                      review-request tasks → closed once gh shows the PR reviewed/merged (D-21)
│                      user replies on own tasks → "Process task replies" routine (Assistant)
├── transcript watcher (systemd --user .path) → signed webhook → "Meeting scan"
└── docker compose (project "pennyworth")
    ├── paperclip            pinned ghcr image, 127.0.0.1:3100, Codex agents inside
    ├── ops-mcp              TypeScript: transcripts, matcher, vault writer, routing, review replies, tasks
    ├── google-workspace-mcp read-only Calendar/Drive/Docs/Gmail, multi-account
    ├── slack-mcp            read-only proxy to mcp.slack.com (allowlisted read tools)
    └── board                127.0.0.1:3120 task board: buckets/rank in its SQLite, everything else via Paperclip as the user (D-22);
                             :3121 on the LAN (pennyworth.local, paired devices from the home subnet only, D-23)
services/paperclip-tasks-mcp  stdio MCP bridge (mounted into paperclip) for task updates by agents
```

Paperclip agents (all `codex_local`), defined in `config/paperclip.yaml`:

| Agent | Purpose |
|---|---|
| Meeting Librarian | meeting memory |
| Chief of Staff | daily brief |
| Slack Scout | Slack items for the user |
| Inbox Agent | emails the user labels `pennyworth` in Gmail become todos |
| Assistant | research and drafts, plus acting on the user's replies |
| Engineer · Codex / · Claude / · GLM | assignment targets only, never woken; pennyworth-runner does the work. The assignee picks the engine, the task's model override picks the model (D-20) |

## Everyday commands

```sh
# tests (run the ones for what you touched)
npm test --prefix services/ops-mcp                 # vitest
npm test --prefix services/google-workspace-mcp
npm test --prefix services/slack-mcp
npm test --prefix services/runner                  # node --test
npm test --prefix services/board                   # vitest (server); npm run typecheck --prefix services/board covers the web app
npm run eval:intake --prefix services/runner       # real comments through the real intake, 3 runs each (~2 min)
npx tsc --noEmit -p services/<svc>/tsconfig.json   # typecheck TS services

# deploy
docker compose up -d --build <ops-mcp|google-workspace-mcp|slack-mcp|board>   # after code changes
docker compose up -d paperclip                     # after compose env/entrypoint changes
node scripts/paperclip-setup.mjs                   # after config/paperclip.yaml or config/agents/*.md changes (idempotent)
systemctl --user restart pennyworth-runner         # after services/runner changes
# the tasks bridge is a mounted file: changes apply on the next agent run

# verify
scripts/healthcheck.sh
scripts/verify-security.sh                         # also scans for secrets; run before every commit
```

### Debugging recipes

- **Call an MCP tool directly:** `docker compose cp scripts/dev/mcp-call.mjs paperclip:/tmp/mcp-call.mjs`, then:

  ```sh
  docker compose exec -T paperclip node /tmp/mcp-call.mjs http://ops-mcp:8080/mcp <tool> '<json>' "$(cat ~/.config/pennyworth/ops_mcp_token)"
  ```

  Use `--list` in place of the tool name to list tools. The tokens for the other servers are `google_mcp_token` and `slack_mcp_token`.
- **Paperclip API as the user:** `Authorization: Bearer $(cat ~/.config/pennyworth/paperclip_board_key)`. The company ID is in `config/system.yaml`.
- **Agent run logs:** `data/paperclip/instances/default/data/run-logs/<company>/<agent>/<run>.ndjson`. The `chunk` fields contain Codex JSON events.
- **Runner:** `journalctl --user -u pennyworth-runner`, plus job logs in `~/.local/state/pennyworth-runner/logs/`.
- **ops-mcp SQLite:**
  - Write a script to a file, pipe it in with `docker compose exec -T ops-mcp sh -c 'cat > /tmp/x.js && node /tmp/x.js'`, and open `/data/ops-mcp/state.sqlite` from it. Inline `-e` quoting breaks on SQL `'$.x'` paths.
  - The state lives in `data/ops-mcp/`.
- **Paperclip DB (read):** run node in the paperclip container with `/app/node_modules/.pnpm/postgres@3.4.9_patch_hash=*/node_modules/postgres`, connecting to `postgres://paperclip:paperclip@127.0.0.1:54329/paperclip`. The API redacts `adapterConfig`, so check stored agent args here.
- **Start a routine now:** `POST /api/routines/<id>/run` with `{"source":"manual"}`. Routine IDs come from `GET /api/companies/<cid>/routines`.

## Rules for changes

- **Read before you write**, and keep edits surgical. Match the surrounding style. TS services use zod and pino; scripts are plain `.mjs` with no dependencies beyond `yaml`.
- **Determinism belongs in code, judgement in agents.** Matching, routing, Obsidian writes and deduplication are ops-mcp code. Agents produce JSON or pick tools. Don't move decisions into prompts.
- **Security posture is non-negotiable.** No Slack/email sends, no Calendar/Drive/Docs writes, no autonomous pushes, read-only Google and Slack scopes. Agents get least-privilege MCP tools per agent (`mcp_servers` / `enabled_tools` in `config/paperclip.yaml`). Source content is untrusted; keep the injection clause in every agent prompt.
- **Tasks are the user's.** Every task Pennyworth creates is assigned to the user (see the Paperclip gotchas). Only create tasks for the user's *own* clear actions; other people's actions stay in the notes.
- **Personal config stays out of git:** `.env`, `config/{system,routing,paperclip,runner}.yaml`, `compose.vault.yaml`, `data/`. Examples live in `config/*.example.yaml`; update both when you add keys. Secrets live in `~/.config/pennyworth/` (0700 dir, 0600 files) and never go in the repo, logs or tasks.
- **Git:**
  - Use conventional commits.
  - Stage explicit paths, **never `git add -A`**. The user keeps unrelated files in the tree; gThumb writes `.comments/` sidecars, which are ignored now.
  - The user has asked for work to be committed to `master` and pushed to `origin` (github.com/taylanpince/pennyworth) once verified. Run `scripts/verify-security.sh` first.
- **NixOS:**
  - Never run `sudo` or switch the system yourself.
  - The user's config is in `~/config` (flake in `~/config/nixos`, Home Manager in `nixos/home/taylan.nix`). Flakes evaluate purely, so vendor modules into that repo rather than importing from here.
  - Validate with `nix eval .#nixosConfigurations.bloomware.config.home-manager.users.taylan…`. The user runs `make switch`.
  - `~/.config/systemd` is a symlink into `~/config/systemd`. Home Manager-generated units must stay gitignored there.
- **Toolchains come from devshells** in `~/config/nixos` (`llm` provides codex, opencode and node; also `go`, `node`, `rust`, `pulumi` (gcloud), …). From a minimal environment, use `nix develop ~/config/nixos#llm --command …`.

## Gotchas learned the hard way

### Editing files

- **`$` in replacement strings.** In JS `String.replace`, `$$` in the replacement means a literal `$`. Script edits to `compose.yaml` turned `$$(cat …)` into `$(cat …)` twice and silently dropped env exports. Use the Edit tool for anything with `$`, then **re-read** the result.
- **`pkill -f <pattern>` can kill your own shell** if the pattern appears in your command line. Use `pgrep -f '[s]ervices/…'` or `$!`.

### Docker and networking (this host)

- **172.16.0.0/12 is blocked.** The NordVPN firewall drops host traffic to Docker's default 172.16/12 pools, except `docker0`. Compose pins `10.231.0.0/24` (backplane, internal) and `10.231.1.0/24` (egress). Don't remove `ipam`.
- **Docker is rootful,** and the user is in the `docker` group. Containers run as `1000:100` (`PUID`/`PGID`), so vault files keep their owner.
- **Secret-file env vars:** Paperclip's entrypoint `export`s `BETTER_AUTH_SECRET`, the agent JWT secret, and the MCP bearer tokens from `/run/secrets`. Verify with `docker compose exec -u 1000:100 paperclip node -e "…/proc/<pid>/environ…"`; `exec` shells don't inherit them.

### Paperclip (v2026.1001.0)

- **Auth and access:**
  - Authenticated+private mode needs `PAPERCLIP_ALLOWED_HOSTNAMES` to include `paperclip` for container-to-container calls (hostname guard).
  - Better Auth endpoints need an `Origin` header.
  - Board API keys act as the user. Agent keys can *create* issues anywhere, but can't update or comment on other issues outside a heartbeat run ("Cross-issue writes need a run").
- **Issues and statuses:**
  - An issue created by an agent key is effectively owned by that agent, so user comments would wake it. Always create with `assigneeUserId` = the company's `defaultResponsibleUserId` (ops-mcp and the bridge do this).
  - Agents can't set `blocked` (needs `unblockDescriptor`) or `in_review` (needs a review path), which triggers "disposition required" spam. The bridge only allows todo, in_progress, done and cancelled; agents finish with `task_handoff` or `done`.
  - `in_progress` requires an assignee.
  - `idempotencyKey` deduplication expires after **7 days**. The bridge's `task_create` also checks open issues for the marker comment (`<!-- source:… -->`).
- **Codex and MCP delivery:**
  - The tool gateway **drops MCP annotations**, so Codex would refuse every write tool (approval policy "never"). MCP servers are therefore written directly into `/paperclip/.codex/config.toml` with `default_tools_approval_mode = "approve"` (by `paperclip-setup.mjs`).
  - Paperclip copies that file into each managed Codex home **only once**, so the setup script also patches existing homes.
  - Give every write tool `readOnlyHint: false, openWorldHint: false`, and every read tool `readOnlyHint: true`.
  - Per-agent scoping uses `-c mcp_servers.<n>.enabled=false` and `-c mcp_servers.<n>.enabled_tools=[…]` in each agent's `extraArgs`.
  - Codex needs `--skip-git-repo-check`, because run workspaces aren't git repos.
  - Its bubblewrap sandbox can't create namespaces in the container, so shell commands fail closed. The shell, browser, apps and computer-use features are disabled on purpose. Web search is off too, except `cached` mode for the Assistant (D-19); never give an agent live web search alongside private-data tools.
  - Paperclip's codex default is `--dangerously-bypass-approvals-and-sandbox`; setup always sends `dangerouslyBypassApprovalsAndSandbox: false`.
- **Agents and routines:**
  - `wakeOnDemand: false` makes an agent assignable but never woken (that's the Engineer).
  - A routine run creates a `todo` issue for the agent and wakes it.
  - `{{date}}` and `{{timestamp}}` are built-in routine variables. Other `{{vars}}` need defaults; setup adds them.
  - Use `always_enqueue` for dispatch routines (Process task replies), so runs aren't coalesced away.

### Google

- **Re-consent can silently switch accounts.** Re-running `scripts/google-auth.sh` once signed in as the *Horizon* account and switched Calendar away from Polygon. Credentials are now multi-account with an explicit primary (`--email … --primary` for tpince@polygon.technology). Calendar and meeting docs use the primary; Gmail and Drive span all accounts.
- **Multi-tab Docs** need the Docs API (`documents.get` with `includeTabsContent`). Drive's text export only returns the first tab; `docs_read` falls back to it.
- **Meet/Gemini titles carry the organizer's timezone** ("09:30 EDT"). `parseMeetDocTitle` maps the abbreviations; extend `TZ_ABBREVIATIONS` if a new one shows up.

### Runner engines

- **opencode auto-rejects unanswered permission prompts and still exits 0.** Its defaults `ask` for `external_directory` and `doom_loop`, so they are set to `allow` (the `codex sandbox` around it is the write boundary). Never treat exit 0 as success: a run only counts as finished if its report has `## Summary` (`runOutcome`).
- **The executor picker is Paperclip's own** (D-20): the Engineer agent's adapter type maps to the engine, and `assigneeAdapterOverrides.adapterConfig` holds the model and effort. When a comment names an engine or model, the runner rewrites the assignee and override to match, so don't keep a second copy of the engine anywhere else.
- **Sessions are engine-specific.** A Codex thread ID can't be resumed by opencode (`ses_…` IDs) or Claude Code; switching engines starts fresh with the task's earlier requests as context.
- **Claude Code must not inherit the user's Claude setup.** By default `claude -p` loads every MCP server, plugin, hook and claude.ai connector (Slack send, Calendar writes, GitHub MCP pushes…). The runner uses its own `CLAUDE_CONFIG_DIR`, a `setup-token` OAuth token, `--setting-sources ""`, `--strict-mcp-config` with no servers, `ENABLE_CLAUDEAI_MCP_SERVERS=false` and a `--tools` allowlist. Don't point it at `~/.claude`: writable hooks or settings there would run unsandboxed in the user's own sessions.
- **`claude --mcp-config` is variadic** and swallows a trailing prompt argument; the runner sends the prompt on stdin.

### Slack

- `mcp.slack.com` has no dynamic client registration. It needs Polygon's public client (`SLACK_CLIENT_ID` in `.env`, callback `http://localhost:3118/callback`, PKCE, no secret) and rotating refresh tokens, which are persisted read-write in `~/.config/pennyworth/slack/`.
- Claude Code's own Slack MCP login uses the same port, 3118.

## User preferences (owner: Taylan Pince)

- **Tasks:**
  - Tasks only for *his own* clear action items. No waiting-on tasks for other people's commitments, and no tasks for ownerless actions.
  - **Email:** only threads he labels `pennyworth` in Gmail (any account, archived or not) become todos, closed when he removes the label. Never mirror the whole inbox: that produced junk tasks (meeting accepts, receipts).
  - Replies on meeting match review tasks (`pick N`, `ignore`) are handled by ops-mcp. Replies on other tasks go to the Assistant. Code work is assigned to an Engineer: Engineer · Codex, · Claude or · GLM, with the model picked on the task. "use Claude" or "use GLM" in a comment still works and moves the picker.
  - **Plain language only.** The runner has no `key: value` syntax. Every comment except an exact `push`/`pr` goes through the intake (`services/runner/src/intake.mjs`), which picks the action (run/stop/status/reset/cleanup), repo, mode (answer/investigate/implement) and engine; code validates each answer. Never add syntax he has to learn. Publishing stays on the exact word.
  - **Intake regression set:** `config/intake-cases.yaml` (personal, gitignored; example in `config/intake-cases.example.yaml`) holds his real comments and the reading each must get. Run `npm run eval:intake` before shipping any change to the intake prompt, its inputs, or how the runner acts on its answers, and add every misread found on a real task. Unit tests can't catch these: the intake answers differently from run to run (the old PEN-298 prompt misread the request 3 runs out of 4).
- **Writing:** drafts (agendas, documents) go in task comments for him to review and paste. No Docs writes for now (option 1).
- **Routing:** never ask him where a meeting goes ("choose a note" tasks were removed, D-18). Rules in `config/routing.yaml` and remembered routes win; otherwise the Meeting Librarian best-guesses an existing note or writes only the canonical note. Don't add routing rules he didn't ask for.
- **Working style:** he likes being asked crisp decision questions with a recommendation, and otherwise expects you to proceed end to end and verify on the real system.
