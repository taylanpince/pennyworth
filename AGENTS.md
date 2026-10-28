# AGENTS.md

Guidance for coding agents working on **Pennyworth**, a personal executive assistant built on Paperclip. Read `README.md` for the user-facing overview, `docs/SPECS.md` for the original spec, and `docs/DECISIONS.md` (D-1 to D-50) for why things are the way they are. This file covers how to work on the system and the traps already found.

## System map

```text
host (NixOS, user taylan)
├── pennyworth-runner (systemd --user, node, runs AS THE USER)   services/runner/
│     polls Paperclip: engineer tasks → Codex/Claude Code/OpenRouter jobs in per-task workspaces under ~/pennyworth/tasks (D-41),
│                      Claude Code and Codex jobs read Grafana and Google Cloud, read-only (D-48),
│                      or a merge queue for the PRs a task lists, in code (D-46)
│                      review-request tasks → closed once gh shows the PR reviewed/merged (D-21)
│                      user replies on own tasks → "Process task replies" routine (Assistant)
│                      recurring runs claimed from the board → GitHub activity comment → "Run recurring task" (D-25)
├── transcript watcher (systemd --user .path) → signed webhook → "Meeting scan"
└── docker compose (project "pennyworth")
    ├── paperclip            pinned ghcr image, 127.0.0.1:3100, Codex agents inside
    ├── ops-mcp              TypeScript: transcripts, matcher, vault writer, routing, review replies, tasks; reference docs (D-38);
    │                        the user's writing voice guide, lessons added on their word (D-47)
    ├── google-workspace-mcp read-only Calendar/Drive/Docs/Gmail, multi-account; sign-in state and board reconnect (D-36)
    ├── slack-mcp            proxy to mcp.slack.com (allowlisted read tools, plus drafts for the Assistant, D-46)
    ├── telegram-mcp         the user's own Telegram session, reads only by a request guard; live updates + sweep; board sign-in (D-37)
    ├── primer-mcp           proxy to the org's Primer: read, plus publish documents/versions for the Assistant (D-31);
    │                        reads only on 127.0.0.1:3123/mcp/read for the runner's Engineer jobs (D-40);
    │                        the runner itself publishes an Engineer task's document on /mcp (D-44)
    ├── glean-mcp            proxy to the org's Glean: read-only search for the Assistant; board sign-in (D-38)
    ├── grafana-mcp          proxy to Grafana's hosted MCP (GRAFANA_URL): read/query scopes only, for Engineer jobs on 127.0.0.1:3124;
    │                        board sign-in (D-48)
    ├── github-mcp           GitHub issues/PRs with the user's gh token: read; when asked, in GITHUB_COMMENT_ORGS: comment, open issues (on a project board),
    │                        close/label/assign issues, review PRs, re-run failed CI (D-39, D-42, D-46)
    └── board                127.0.0.1:3120 task board: buckets/rank in its SQLite, everything else via Paperclip as the user (D-22);
                             files attached as context go to Paperclip's attachments, PDFs with a text version (D-43);
                             :3121 on the LAN (pennyworth.local, paired devices from the home subnet only, D-23)
                             :3122 internal API (bearer token): scheduled moves and recurring tasks for the bridge and the runner (D-25),
                             and the runner's job activity for the Crew view (D-34, D-45)
services/paperclip-tasks-mcp  stdio MCP bridge (mounted into paperclip) for task updates by agents
```

Paperclip agents (all `codex_local`), defined in `config/paperclip.yaml`. The ones you assign have a persona on the board (D-45): name, one-line voice and portrait.


| Agent | Purpose |
|---|---|
| Meeting Librarian | meeting memory |
| Chief of Staff | daily brief |
| Slack Scout | Slack items for the user |
| Telegram Scout | Telegram mentions, replies and DMs for the user, from the candidates telegram-mcp picks |
| Inbox Agent | emails the user labels `pennyworth` in Gmail become todos |
| Assistant (**Alfred**) | research and drafts (Slack, Telegram, Google, Primer, Glean, GitHub issues, notes, reference docs, cached web, files attached to tasks), publishing to Primer, Slack drafts, and GitHub comments, issues, reviews and CI re-runs when asked, acting on the user's replies (including scheduling a task or making it recurring, and learning how the user writes when asked, D-47), and running recurring tasks |
| Engineer · Codex (**Grace**) / · Claude (**Ada**) / · OpenRouter (**Linus**) | assignment targets only, never woken; pennyworth-runner does the work. The assignee picks the engine, the task's model override picks the model (D-20). Grace and Ada also read Grafana and Google Cloud (D-48) |

## Everyday commands

```sh
# tests (run the ones for what you touched)
npm test --prefix services/ops-mcp                 # vitest
npm test --prefix services/google-workspace-mcp
npm test --prefix services/slack-mcp
npm test --prefix services/telegram-mcp
npm test --prefix services/primer-mcp
npm test --prefix services/glean-mcp
npm test --prefix services/github-mcp
npm test --prefix services/grafana-mcp
npm test --prefix services/runner                  # node --test; test/flow.test.mjs runs the real runner against a fake Paperclip and fake engines
npm test --prefix services/board                   # vitest (server); npm run typecheck --prefix services/board covers the web app
npm run eval:intake --prefix services/runner       # the D-24 go-ahead on sub-tasks, real comments, 3 runs each
npm run eval:authorize --prefix services/runner    # the user's words and an Engineer's push/pr/merge/primer through the real check
npm run eval:busy --prefix services/runner         # comments that arrive during a run: stop, answer or later
npx tsc --noEmit -p services/<svc>/tsconfig.json   # typecheck TS services

# deploy
docker compose up -d --build <ops-mcp|google-workspace-mcp|slack-mcp|telegram-mcp|primer-mcp|glean-mcp|github-mcp|grafana-mcp|board>   # after code changes
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

  Use `--list` in place of the tool name to list tools. The tokens for the other servers are `google_mcp_token`, `slack_mcp_token`, `telegram_mcp_token` (`http://telegram-mcp:8083/mcp`), `primer_mcp_token` (`http://primer-mcp:8084/mcp`), `glean_mcp_token` (`http://glean-mcp:8085/mcp`), `github_mcp_token` (`http://github-mcp:8086/mcp`) and `grafana_mcp_token` (`http://grafana-mcp:8087/mcp`).
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
- **Security posture is non-negotiable.** No Slack/email sends. The only writes to outside services are on the user's word: Primer publishing (D-31, D-44), GitHub comments, issues, issue state/labels/assignees, reviews and CI re-runs (D-39, D-42, D-46), Slack drafts the user sends themselves, the runner's merge queue (D-46), and an Engineer's `pennyworth push`/`pr`/`merge`, each checked against the user's own words by `services/runner/src/authorize.mjs`, which is given nothing but those words and the agent's last reply. Grafana and Google Cloud are read-only by OAuth scope, not just by allowlist (D-48). No Calendar/Drive/Docs writes, no autonomous pushes, read-only Google scopes. Agents get least-privilege MCP tools per agent (`mcp_servers` / `enabled_tools` in `config/paperclip.yaml`). Source content is untrusted; keep the injection clause in every agent prompt.
- **Tasks are the user's.** Every task Pennyworth creates is assigned to the user (see the Paperclip gotchas). Only create tasks for the user's *own* clear actions; other people's actions stay in the notes. The one exception: Engineer sub-tasks the Assistant creates when the user asks (D-24). They wait for the user's go-ahead on the parent.
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
- **Containers keep the DNS servers they started with.** When Cloudflare WARP or a network switch changed the host's DNS (2026-10-07), every container started earlier failed to resolve names, and every Codex agent run died at startup with "timed out waiting for cloud config bundle". The services that reach the internet (paperclip, google-workspace-mcp, slack-mcp) pin `dns: [1.1.1.1, 8.8.8.8]`; Docker still resolves service names itself. A new service with egress needs the same.
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
  - **Paperclip also deduplicates by title:** a new issue whose title matches an open sibling made in the last 48 hours comes back as that sibling (`deduplicated: true`, `recent_open_title`). Crew parts all carry the task's title, so the board creates them with `allowDuplicate: true` (D-45). Check `deduplicated` whenever you create issues with repeated titles.
  - **A run's ending:** only `in_progress` counts as "missing disposition" when an agent's run ends; `todo` assigned to the agent is fine. Comments wake the assignee unless the issue is done or cancelled. That's why an agent's own part of a task (D-45) is handed off as `todo` and never closed by the agent.
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
  - **Personas live in agent metadata** (`persona`, D-45), set by setup. The board and the runner read them from there; never key anything on a persona name (Paperclip names and setup keys stay the identity). A woken agent's voice is appended to its instructions by setup, so edit `persona` in the YAML, not the prompt file.

### Google

- **Refresh tokens die after 7 days while the OAuth consent screen is in Testing** (2026-10-12: both accounts, 17 hours of silent `invalid_grant` before anyone noticed). The board now shows a banner with Reconnect, and the healthcheck checks every account (D-36). The cure is publishing the consent screen to In production.
- **Re-consent can silently switch accounts.** Re-running `scripts/google-auth.sh` once signed in as a secondary account and switched Calendar away from the work account. Credentials are now multi-account with an explicit primary (`--email … --primary` for the work account). Calendar and meeting docs use the primary; Gmail and Drive span all accounts.
- **Multi-tab Docs** need the Docs API (`documents.get` with `includeTabsContent`). Drive's text export only returns the first tab; `docs_read` falls back to it.
- **Meet/Gemini titles carry the organizer's timezone** ("09:30 EDT"). `parseMeetDocTitle` maps the abbreviations; extend `TZ_ABBREVIATIONS` if a new one shows up.

### Runner engines

- **A request has to go all the way through before it ships.** `test/flow.test.mjs` runs `src/main.mjs` from a task on a fake Paperclip to a finished job, with fake `nix`, `bwrap`, `codex`, `claude` and `gh` and local repositories for GitHub. Three bugs on 2026-10-27 (a question about repositories the user had listed, a variable used before it was set, repositories only on the parent task) passed every unit test and stopped real jobs; extend the flow test when you change `handleRequest` or `startJob`.
- **opencode auto-rejects unanswered permission prompts and still exits 0.** Its defaults `ask` for `external_directory`, `doom_loop` and reading `*.env`/`*.env.*` files (tracked ones too: PEN-2421 stopped at its first `.env.prod`), so they are set to `allow` (the `codex sandbox` around it is the write boundary). Never treat exit 0 as success: a run only counts as finished with a reply (or the agent's `NO_REPLY`), see `runOutcome`. A run that gives up mid-thought now posts that line as its reply; the user says "continue".
- **The executor picker is Paperclip's own** (D-20): the Engineer agent's adapter type maps to the engine, and `assigneeAdapterOverrides.adapterConfig` holds the model and effort. When a comment names an engine or model, the runner rewrites the assignee and override to match, so don't keep a second copy of the engine anywhere else.
- **Everything that reaches GitHub is for the repo's reviewers,** who don't know Pennyworth and can't see Paperclip. PR titles and bodies come from `services/runner/src/describe.mjs` (a Codex call that follows any PR wording in the task or its parent, with `leaksInternal` falling back to the commit messages), commit subjects pass `publicSubject`, and the agent prompt forbids Pennyworth/Paperclip/PEN-numbers/local paths in the repo. Never add task numbers or tool names to commits or PRs (PR #44 on zkevm-techdocs said "Draft opened by Pennyworth for Paperclip task PEN-406").
- **Engineers publish and merge with their own tools (stage 2).** `bin/pennyworth status|push|pr|merge` posts to the per-run loopback endpoint (`src/repohelper.mjs`, `TOOLS`). push and pr are the runner's own `publish()` with a `check` that runs `authorize()` before anything leaves; merges the agent queues start when its run ends. A refusal goes back to the agent, which asks. The check reads only the user's comments around the agent's last reply (`wordsAround`); exact `push`/`pr` comments the runner already carried out are left out, so they can't allow anything twice.
- **Every run gets the conversation (stage 1 of `docs/design/conversational-engineers.md`).** `src/thread.mjs` labels each comment (the user, the Engineer's own replies, marked `<!-- pennyworth-reply -->`, the runner, other agents) and reads the live branch/PR/merge state. A new session gets everything; a resumed one gets what's new since `thread_upto:<issue>`; this run's own request is left out because the instructions carry it. Only the user's comments are instructions; the rest is fenced.
- **Push forces only over the task's own earlier version (D-49).** A rewritten branch (rebase, amend) is pushed with `--force-with-lease` pinned to GitHub's tip, and only if that tip is in the branch's own reflog, so commits a reviewer or CI pushed are never overwritten. Don't widen it: no plain `--force`, no lease on a tip the task never had.
- **Repositories outside `allowed_orgs` are read-only (D-35).** Public ones are candidates once `gh` confirms them (bare `a/b` tokens such as "DA/L1" aren't repos); implement, push and pr there are refused in code with a message saying why. Before this, they were silently dropped from the old intake's candidates, and it asked "which repository?" forever (PEN-875).
- **Workspaces, not worktrees (D-41).** Each task has `~/pennyworth/tasks/<task>/` with a full clone per repository (a local clone of the cache in `~/pennyworth/repos`, so objects are hardlinked and every write stays inside the workspace, which is the sandbox's only writable root). The agent branches and commits itself. Its commits are unsigned (no SSH agent; `GIT_CONFIG_*` env turns `commit.gpgsign` off), and the runner re-signs them after the run with `commit-tree -S` (`signUnsigned`, same trees, only commits GitHub doesn't have). Branches are found from git, not trusted from the agent: every local branch with commits the default branch lacks; `.pennyworth/branches.json` only sets bases and purposes. Codex needs `--skip-git-repo-check` because the workspace root isn't a repository.
- **`pennyworth-repo` clones mid-run** through a loopback endpoint in the runner (`src/repohelper.mjs`, random port, a token per job): the agent can't clone private repositories itself.
- **Tasks from before D-41** (one worktree of the cache, `tasks.branch`/`pr_url`) move into a workspace on their next run or command (`moveIntoWorkspace`): branch, PR and uncommitted changes come along, the session restarts.
- **Sessions are engine-specific.** A Codex thread ID can't be resumed by opencode (`ses_…` IDs) or Claude Code; switching engines starts fresh with the task's earlier requests as context.
- **Claude Code must not inherit the user's Claude setup.** By default `claude -p` loads every MCP server, plugin, hook and claude.ai connector (Slack send, Calendar writes, GitHub MCP pushes…). The runner uses its own `CLAUDE_CONFIG_DIR`, a `setup-token` OAuth token, `--setting-sources ""`, `--strict-mcp-config` with no servers, `ENABLE_CLAUDEAI_MCP_SERVERS=false` and a `--tools` allowlist. Don't point it at `~/.claude`: writable hooks or settings there would run unsandboxed in the user's own sessions.
- **Primer is the one MCP server every engine gets (D-40),** read-only through primer-mcp's loopback `/mcp/read`. Primer links redirect to Okta for WebFetch, so without it a job can't read a linked spec. The bearer token goes in as `PRIMER_MCP_TOKEN` in the environment, never on the command line. Don't add other servers to Engineer jobs. When the user asks for a Primer report, the agent writes `.pennyworth/primer.md` and the *runner* publishes it after the run (D-44); never give a job the publishing endpoint.
- **Grafana and Google Cloud go to Claude Code and Codex only (D-48),** never OpenRouter (`observes`). Grafana is grafana-mcp's loopback `/mcp` (`GRAFANA_MCP_TOKEN` in the environment, like Primer). Google Cloud is a one-hour token narrowed to `READ_SCOPES` in `services/runner/src/gcp.mjs`, in the job's own gcloud config; the sign-in itself (`scripts/gcloud-auth.sh`) is broad and never reaches a job.
  - **Never add `cloud-platform.read-only` or `devstorage.read_only` to `READ_SCOPES`:** some APIs accept them for writes (Agent Registry deletes, liens, BigQuery DML jobs). Before adding any scope, check every API in Google's discovery directory for non-GET methods that accept it.
  - **Codex drops variables named `*TOKEN*`/`*KEY*`/`*SECRET*` from its tool calls,** so gcloud's token file goes in as a property in `CLOUDSDK_CONFIG`, not `CLOUDSDK_AUTH_ACCESS_TOKEN_FILE`. The same applies to anything else a Codex job's shell must see.
  - **Every job runs under `bwrap --tmpfs` over the gcloud sign-ins** (`gcp.hidden`): the sandbox only limits writes, and gcloud would otherwise use the user's own `~/.config/gcloud`. bwrap comes from the `llm` devshell (`~/config/nixos/shells/llm.nix`), not the host: the runner's systemd PATH has none, so a test from an interactive shell can pass while every job fails with `bwrap: not found` (PEN-2714). `scripts/healthcheck.sh` checks the job tools with the runner's own PATH. An outer bwrap around `codex sandbox` works on this host.
  - **The Google Cloud session lasts 16 hours** (the user's own Workspace policy, 2026-10-01). After that refreshes fail with `rapt_required`; jobs run without Google Cloud and say so. Don't look for a way around it.
  - **No repository needed:** with none named in the request, the task or its parent, the workspace starts empty and the agent clones what it needs (`pennyworth repo`). The runner never asks which repository.
- **`claude --mcp-config` is variadic** and swallows a trailing prompt argument; the runner sends the prompt on stdin.

### Telegram

- **The session is the whole account (D-37).** It could send, delete or log other devices out; only `services/telegram-mcp/src/guard.ts` stops that. Every GramJS request goes through `client.invoke`, which the guard replaces with a check against `READ_REQUESTS` (Get*/Search* reads only). Never call the GramJS sender directly, never add a request to that list without checking what it does, and never give the reading client `auth.*` (sign-in has its own short-lived client in `login.ts`). A refused request logs `refused a Telegram request that isn't a read` with its class name: that is a bug to fix in our code, not a list to extend.
- **Reading must never mark anything read.** `messages.ReadHistory`, `channels.ReadHistory`, `messages.ReadMentions` and `account.UpdateStatus` are refused on purpose: the user's unread badges, mention counters and "online" status are theirs. GramJS helpers such as `markAsRead` exist; don't use them.
- **Chat refs are `tg:<marked peer id>`** and stable. Tasks made before D-37 carry the organization MCP's old refs; follow-ups find those chats by title.
- **Telegram's `mentioned` flag** covers @mentions, name links and replies to the user's messages. The scout checks the replied-to message to tell "reply" from "mention"; aliases (`TELEGRAM_ME_ALIASES`) catch plain-text names.
- **Message IDs have gaps:** small groups and DMs share the account's ID counter. Read "the messages before" with `read_chat_history`, never by ID range. `read_chat_history` returns newest first, up to 50; `get_new_messages` returns the earliest after an ID, oldest first, up to 100.
- **Cloudflare WARP answers port 80 to Telegram itself** (`HTTP/1.1 400`, 2026-10-27), so MTProto there hangs or times out on reconnect. The client uses the obfuscated transport on 443 (`useWSS: true`, plain TCP in Node); keep both. GramJS's own reconnect only prints a dead session and retries every second, so `onError` restarts from the stored session instead (an hour of that loop once ran the process out of memory).
- **Content is wrapped** in `<untrusted-telegram-content>` tags by telegram-mcp, and people paste API keys into these chats. The scout prompt forbids copying credentials into tasks. Message text is never written to disk or logged.

### Primer

- **Primer moved hosts on 2026-10-26** (`primer-polygon.up.railway.app` → `primer.polygon.tools`). The old host answers 308, which the MCP client won't follow, so every Primer call failed. The OAuth token survived the move: update `PRIMER_MCP_URL` in `.env` and `token_endpoint`/`resource` in `~/.config/pennyworth/primer/token.json`, then recreate primer-mcp. No new sign-in needed.
- The new host answers an expired token with `{"error":"unauthenticated"}`; the proxy's auth-failure check must match it, or it doesn't refresh until its 30-minute reconnect.

### Glean

- **Redirect URIs are restricted by admin policy** (2026-10-15). Dynamic registration refuses most loopback callbacks (`invalid_redirect_uri … not permitted by administrator policy`); `http://127.0.0.1:3120/callback` works, `/glean/callback` doesn't. That's why the board's Glean callback is the bare `/callback`. Probe a new redirect with a registration request before building on it.
- Request `offline_access` with the resource's `mcp` scope, or there may be no refresh token.

### Grafana

- **One server for every stack:** `mcp.grafana.com` serves any Grafana Cloud stack, picked by the `X-Grafana-URL` header. Its OAuth server is per stack: the 401's `WWW-Authenticate: resource_metadata` points at `/.well-known/oauth-protected-resource/mcp/gurl/<base64 of the stack URL>`, whose authorization endpoint already carries `?grafana_url=…` (append parameters, never replace the query). Dynamic registration takes loopback callbacks; client IDs are stateless JWTs.
- **Scopes are the boundary:** `grafana:read grafana:query`, never `grafana:write`. Grafana doesn't offer `offline_access`; if a sign-in comes without a refresh token, the board asks to Reconnect when it expires.
- **Tool names come from the hosted server and change:** grafana-mcp logs the upstream list next to the exposed one on connect. A new read tool needs adding to `READ_TOOLS` by hand; never expose gcx, handlers, investigations or SQL datasources.

### GitHub (Assistant)

- **github-mcp holds the user's full gh token (D-39).** Only `guard` in `services/github-mcp/src/github.ts` limits it: fixed read routes plus issue comments, new issues, and GraphQL limited to the documents in `GRAPHQL` (D-42: project read, add item, set status). Never add a generic request tool, never call fetch with the token outside `request`, never let a caller pass GraphQL text, and check what a route or document does before adding it. The token is re-read on every call; `scripts/github-auth.sh` refreshes it in place.
- The cached web search can't open private repositories (404): GitHub links go through `github_issue_read`.

### Slack

- **The token can send (D-46).** Slack granted `chat:write` and the app's other write scopes even though consent asks for reads, so only `services/slack-mcp/src/policy.ts` stops sends: the `NEVER` pattern, with `slack_send_message_draft` the one exact-name exception and its arguments limited to `DRAFT_ARGS`. Never loosen `NEVER` or add a send tool; a new draft-like tool needs the same treatment.

- `mcp.slack.com` has no dynamic client registration. It needs a public client registered for the user's workspace (`SLACK_CLIENT_ID` in `.env`, callback `http://localhost:3118/callback`, PKCE, no secret) and rotating refresh tokens, which are persisted read-write in `~/.config/pennyworth/slack/`.
- Claude Code's own Slack MCP login uses the same port, 3118.

## User preferences (owner: Taylan Pince)

- **Tasks:**
  - Tasks only for *his own* clear action items. No waiting-on tasks for other people's commitments, and no tasks for ownerless actions.
  - **Email:** only threads he labels `pennyworth` in Gmail (any account, archived or not) become todos, closed when he removes the label. Never mirror the whole inbox: that produced junk tasks (meeting accepts, receipts).
  - **Slack hand-offs:** messages he reacts to with :pushpin: become todos, closed when he removes the reaction (D-30). Not Slack's Later list: `is:saved` search also returns hundreds of completed items, and `saved.list` refuses OAuth tokens.
  - Replies on meeting match review tasks (`pick N`, `ignore`) are handled by ops-mcp. Replies on other tasks go to the Assistant. Code work is assigned to an Engineer: Engineer · Codex, · Claude or · OpenRouter (GLM, DeepSeek… listed under its `models`), with the model picked on the task. "use Claude" or "use DeepSeek" in a comment still works and moves the picker.
  - **Branches follow the target repo's conventions (D-32).** The agent names its branches in each repository's style (the prompt carries the contributing rules and his recent branch names), and the runner renames any that aren't publishable (`pennyworth/…`, internal words) after the run. Never push a `pennyworth/…` branch to a new PR: those repos have nothing to do with Pennyworth.
  - **Scheduling and recurring tasks (D-25):** "bring this back on Tuesday" or "make this repeat every Monday" in a comment goes to the Assistant, which calls `task_schedule` / `task_recurring`. Dates and rules are validated and run by board code. A recurring task's description is its instructions, and each run lands on top of Today as a draft for him to finish (no per-run approval: his choice). Runs default to 07:00.
  - **Today and Tomorrow (D-28):** Tomorrow means the next workday (Friday's lands on Monday). Leftovers stay on top of Today, marked "Carried Nd", with one-click Keep / → Tomorrow / → Later. Never move leftovers automatically.
  - **Several branches, PRs and repositories in one task (D-41):** that's how he works in his own sessions, and for some repos it's essential. The agent makes as many branches as the work needs, stacks them, and works in several repositories; **push**/**pr** publish all of them. For a big fan-out (the same change in 20 repos) he still asks the Assistant to split the task into Engineer sub-tasks (D-24), then says "go" once on the parent. Manual steps, such as archiving repos, go in a checklist comment, not tasks or scripts.
  - **He talks to the Engineers like to a colleague (D-50).** Every comment except an exact `push`/`pr` is a turn of the Engineer's conversation, with the whole task in context; there is no request classifier, no modes and no report template. Never add syntax he has to learn, and never put a reader between him and the agent: the only readings left are the go-ahead (D-24), the check on writes (`authorize.mjs`) and comments during a run (`busy.mjs`), each with its eval. The exact `push`/`pr` stay as instant shortcuts; otherwise Engineers publish and merge with their `pennyworth` tools when his words ask for it (stage 2 of `docs/design/conversational-engineers.md`). Run `npm run eval:authorize` before any change to the check's prompt or inputs, and add every misread to `config/authorize-cases.yaml`.
  - **Regression sets for the readings:** `config/{authorize,busy,intake}-cases.yaml` (personal, gitignored; examples next to them) hold his real comments and the answer each must get. Run the matching eval before any change to a reading's prompt or inputs, and add every misread found on a real task. Unit tests can't catch these: the calls answer differently from run to run (the old intake misread PEN-298 3 runs out of 4).
- **Writing:** drafts (agendas, documents) go in task comments for him to review and paste. No Docs writes for now (option 1).
- **Recordings:** a local recording should match its meeting without asking (D-26: the recording's span inside the event). Once published, the transcript is renamed the way his old `~/config/scripts/rename-transcript.sh` did (`<Title>-<date>.txt`, 1:1s in `1-1s/`) and its audio deleted. Meeting notes carry `tags: [type/meeting]`.
- **Routing:** never ask him where a meeting goes ("choose a note" tasks were removed, D-18). Rules in `config/routing.yaml` and remembered routes win; otherwise the Meeting Librarian best-guesses an existing note or writes only the canonical note. Don't add routing rules he didn't ask for.
- **Working style:** he likes being asked crisp decision questions with a recommendation, and otherwise expects you to proceed end to end and verify on the real system.
