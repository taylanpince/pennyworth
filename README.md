<p align="center">
  <img src="docs/pennyworth_sm.png" alt="Pennyworth" width="160">
</p>

# Pennyworth

A local-first personal operations system. Paperclip is the control plane (agents, tasks, routines), Obsidian is the long-term memory, and a small deterministic service, **ops-mcp**, sits between them.

Phase 1, **local meeting memory**, is implemented. Meeting transcripts are matched to Google Calendar events, then the system writes:

- a canonical meeting note to Obsidian;
- a dated entry under `## Meeting Log` in the right project note;
- Paperclip tasks for genuine action items.

All of it is idempotent, and nothing ambiguous is ever written. The spec lives in [`docs/SPECS.md`](docs/SPECS.md). Every deviation from it is explained in [`docs/DECISIONS.md`](docs/DECISIONS.md).

```text
host (NixOS)
├── ~/Documents/transcripts ──(read-only)──┐
├── Obsidian vault: only polygon/, sequence/, people/, Meetings/ ──(rw)──┐
├── systemd --user path watcher ── signed webhook ──┐                     │
└── docker compose (all containers: non-root, cap_drop ALL, no-new-privileges)
    ├── paperclip              127.0.0.1:3100 only; Codex agents (read-only sandbox, no shell)
    │   └── Meeting Librarian ── MCP ──► ops-mcp, google-workspace-mcp, paperclip-tasks bridge
    ├── ops-mcp                no Internet route; SQLite state; the only vault writer
    └── google-workspace-mcp   Calendar + Drive, read-only scopes, GET requests only
```

## Commands

| | |
|---|---|
| Start everything | `docker compose up -d` |
| Stop everything | `docker compose down` (no agent keeps running on the host) |
| Health | `scripts/healthcheck.sh` |
| Security acceptance checks | `scripts/verify-security.sh` |
| Backup / restore | `scripts/backup.sh` / `scripts/restore.sh <archive>` (restore refuses while running) |
| Re-apply Paperclip config | `node scripts/paperclip-setup.mjs` (idempotent) |
| Wake the Meeting Librarian now | `scripts/trigger-meeting-scan.sh` |
| Your todo list | `scripts/todo.mjs` (see [Todo list](#todo-list)) |
| Logs | `docker compose logs -f ops-mcp` (structured; no transcript text, no secrets) |
| Tests | `npm test --prefix services/ops-mcp` and `npm test --prefix services/google-workspace-mcp` |

## First run

Already done for you: `scripts/bootstrap.sh` (secrets in `~/.config/pennyworth`, config files, data dirs, vault mounts), image builds, and `docker compose up -d`. To start from scratch on another machine: `cp .env.example .env`, edit it, then run `scripts/bootstrap.sh` and `docker compose up -d --build`.

1. **Create your Paperclip account and provision everything.** This prompts for an email and password, creates the account, claims the instance, then creates the company, labels, Meeting Librarian, routine and webhook:

   ```sh
   node scripts/paperclip-setup.mjs
   ```

   Afterwards, set `PAPERCLIP_DISABLE_SIGN_UP=true` in `.env` and run `docker compose up -d`.

2. **Log Codex in with your company ChatGPT account** (device flow, once):

   ```sh
   docker compose exec -it -u node paperclip codex -c 'cli_auth_credentials_store="file"' login --device-auth
   ```

   The `-u node` matters: the server must be able to read the resulting `/paperclip/.codex/auth.json`.

3. **Connect Google read-only** (see [Google](#google) below):

   ```sh
   scripts/google-auth.sh ~/Downloads/client_secret_….json
   ```

4. **Install the transcript watcher** with the Home Manager snippet in [`nix/README.md`](nix/README.md).

5. **Check:** `scripts/healthcheck.sh` should be all green.

Then drop a transcript into `~/Documents/transcripts`, or have a Meet call that produces a transcript, and watch the **Meeting scan** task in Paperclip at <http://localhost:3100>.

## How meeting processing works

1. **Wake-up.** The watcher, or the 15-minute work-hours schedule, fires the *Meeting scan* routine. The Meeting Librarian (Codex) wakes up.
2. **Scan.** `transcripts_scan` registers new or changed files and returns work items.
   - Files are identified by canonical path and SHA-256. A changed file becomes a new revision.
   - Files must be unchanged for `stability_seconds` before they count.
3. **Match.** For each item the agent reads the calendar for the item's time window and passes all events to `meeting_match`. ops-mcp scores each candidate:

   | Component | Points |
   |---|---|
   | Time | 0–50 |
   | Title | 0–20 |
   | People | 0–15 |
   | Filename | 0–10 |
   | Meet link / location | 0–5 |

   It then decides:
   - **≥ 75 and unambiguous:** matched.
   - **55–74, or ambiguous:** a review task.
   - **< 55:** unmatched, retried later.

   A Drive document attached to exactly one event is matched to it directly.
4. **Publish.** The agent reads the source and calls `meeting_publish` with a structured extraction (summary, decisions as explicit or probable, actions with owner and deadline only when stated, open questions). ops-mcp then:
   - creates `Meetings/YYYY/MM/YYYY-MM-DD HHMM - Title.md`;
   - routes the meeting: explicit rules, then remembered choices, then topic keywords, else a "choose a note" task;
   - appends the Meeting Log entry with a `<!-- paperclip-meeting:<event id> -->` marker (never twice);
   - creates action tasks with markers: `meeting-action` for yours, `waiting-on` for other people's.

### Resolving review tasks

Comment on the task in Paperclip, then wait for the next scan, or click **Run now** on the Meeting scan routine:

- **Which meeting was this?** `pick 2` (number from the list) or `ignore`.
- **Which note should get it?** `route polygon/agglayer/JPM.md`, or `route none`. The answer is remembered for that recurring series and for similar titles.

### Routing rules

Edit `config/routing.yaml` (examples inside). Explicit regex rules always win. Targets must be existing notes in the mounted vault folders.

## Todo list

Your todo list lives in Paperclip. It contains your own items (label `todo`) plus action items from meetings (`meeting-action`). The Chief of Staff ranks it every weekday at 08:30 in the **Daily Brief** task. It only *suggests* priority changes; you decide.

```sh
todo                                 # open todos + meeting actions, by priority
todo add "Draft OMS roadmap" -p high -n "for Thursday's review"
todo prio PEN-12 critical            # critical | high | medium | low
todo done PEN-12 "sent to Alice"
todo show PEN-12
todo waiting                         # what other people owe you
todo brief                           # today's daily brief
todo --all                           # include reviews and briefs
```

`todo` is `scripts/todo.mjs`; alias or symlink it onto your PATH. You can also add and edit tasks in the Paperclip UI. Give them the `todo` label so they show up here and in the brief.

## Agents

| Agent | Runs | Can use |
|---|---|---|
| Meeting Librarian | file watcher + every 15 min, weekdays 08–20 | ops-mcp; Calendar/Drive read; close or comment on its own tasks |
| Chief of Staff | weekdays 08:30 → "Daily Brief — date" | Calendar read (list/get events only); Paperclip task list/create/update |
| Slack Scout | every 30 min, weekdays 08–20 | Slack read/search only; Paperclip task search/create/update/close |
| Assistant | when assigned, and on your task replies | Slack/Docs/Drive/Calendar read; notes read + meeting-note corrections; Paperclip tasks incl. hand-back |
| pennyworth-runner (host service, not a Paperclip agent) | your comments on `engineer` tasks | Codex/OpenRouter in its own git worktrees, as you; read-only gh; no pushes except your `push`/`pr` |

Each agent sees only the MCP servers and tools listed for it in `config/paperclip.yaml` (`mcp_servers`, `enabled_tools`). Everything else is disabled in its Codex arguments. Run a routine on demand with "Run now" in Paperclip.

## Assistant

For anything that isn't code: research, drafts, and acting on your replies.

- **Assign a task to Assistant**, e.g. "Update the agenda for today's JPM call from #ext-… and the previous agendas doc". It reads Slack, Google Docs (all tabs, once the Docs API is enabled), Drive, Calendar and your notes. It posts the deliverable as a comment for you to review and paste, then assigns the task back to you. To follow up, comment and reassign it to Assistant.
- **Reply on any of your tasks.** About 90 seconds after your last comment, pennyworth-runner hands it to the Assistant, which acts on clear intent:
  - fixes names and details in the task and in Pennyworth's meeting notes;
  - records context ("1:1 with her on Thursday");
  - closes the task ("done", "not relevant");
  - answers questions.

  It replies with one line saying what changed. Notes to self that need no action get no reply.

It never sends messages and never edits Slack, Docs or Calendar. In your notes it can only correct text Pennyworth wrote for a meeting.

## Coding jobs (engineer)

Comment on a task and the work happens in a repository on this machine, the way you'd run Codex in a terminal tab, but tracked in Paperclip.

1. Assign the task to **Engineer**, or add the label **engineer**. If you assign it without instructions, it replies "Ready" and tells you what it needs.
2. Comment with what you want. Optional `key: value` lines anywhere in the comment control the run:

   ```text
   repo: 0xPolygon/omsx          # any repo in 0xsequence, 0xPolygon or agglayer (or a GitHub URL)
   mode: implement               # default: investigate (report only, no changes)
   engine: glm                   # default: codex; glm = OpenRouter z-ai/glm-5.3-flash; or openrouter:<model>
   shells: go,pulumi             # devshells from ~/config/nixos; default: detected (+ pulumi when you mention gcloud)
   base: release/v2              # branch to start from; default: the repo's default branch
   Find why the settlement test is flaky and fix it.
   ```

3. The **pennyworth-runner** service (systemd user service, runs as you) picks it up within about 20 seconds:
   - it clones the repo into `~/pennyworth/repos` and creates the worktree `~/pennyworth/tasks/<TASK>-<repo>` on branch `pennyworth/<task>`;
   - it runs the engine inside the devshells, with Codex's sandbox (writes only in the worktree and build caches);
   - it posts the report on the task and sets the status to *in review*.

   In implement mode, the runner commits the changes with the agent's proposed conventional commit message.
4. Follow-up comments continue the same agent session in the same worktree.

Commands (a comment containing only the word):

| Command | What it does |
|---|---|
| `push` | publish `pennyworth/<task>` to GitHub (never forced, never another branch) |
| `pr` | push and open a **draft** PR with the report as description |
| `stop` | cancel the running job |
| `status` | repo, branch, engine, mode, session |
| `reset` | start a fresh agent conversation next time (keeps the worktree) |
| `cleanup` | remove the worktree (the local branch is kept) |

Agents can't push or write to GitHub themselves:

- `gh` is wrapped read-only;
- pushes are disabled in the runner's clones;
- a pre-push hook and an ssh wrapper both refuse pushes;
- after each run, the runner checks that nothing appeared on GitHub.

Only *your* comments are instructions. Task text from Slack, email or meetings is passed to the agent as untrusted context. Job logs are in `~/.local/state/pennyworth-runner/logs/`. Configuration (orgs, engines, devshells, limits) is in `config/runner.yaml`.

```sh
systemctl --user status pennyworth-runner
journalctl --user -u pennyworth-runner -f
```

OpenRouter jobs read the key from `~/.config/pennyworth/openrouter_key` (0600).

## Slack

Pennyworth reads Slack through Slack's official MCP server (`mcp.slack.com`). It uses Polygon's registered OAuth client from go/mcps, a public client with callback `http://localhost:3118/callback`, set as `SLACK_CLIENT_ID` in `.env`.

- The `slack-mcp` sidecar holds your user token, refreshes it (Slack rotates refresh tokens), and exposes **only** read tools: search, read channel/thread, user and channel lookups. Send, draft, schedule, react, canvas and list tools are never listed, and are refused if called.
- Consent asks only for read and search scopes.

```sh
scripts/slack-auth.sh         # once: open the printed URL, approve; then:
node scripts/paperclip-setup.mjs   # re-activates the Slack scan routine
```

The Slack Scout creates three kinds of tasks:

- `needs-response`: someone is waiting for your reply. It is closed automatically once you answer in the thread.
- `todo`: something you promised.
- `waiting-on`: something someone promised you.

Every task carries a permalink and the marker `source:slack:<channel>:<ts>`, so nothing is duplicated. `todo` lists the needs-response items as `reply`.

## Google

Pennyworth uses its own read-only sidecar (`services/google-workspace-mcp`). Paperclip's native Google connector depends on Google's Developer Preview enrollment ([D-9](docs/DECISIONS.md)).

1. In a Google Cloud project under your Workspace account, enable the **Google Calendar API** and the **Google Drive API**.
2. Configure the OAuth consent screen as *Internal* if your Workspace allows it.
3. Create an OAuth client of type **Desktop app** and download its JSON.
4. Run `scripts/google-auth.sh <that json>` (or `scripts/google-auth.sh` with no argument to paste the client ID and secret instead) and approve in the browser. The only scopes requested are `calendar.events.readonly` and `drive.readonly`. The refresh token goes to `~/.config/pennyworth/google_oauth.json` (0600) and is mounted into the sidecar only.

If Workspace policy blocks the consent, nothing else breaks: matching reports "calendar unavailable" and sources stay pending. Do not weaken Workspace settings to work around it.

**Testing without Google:** set `GOOGLE_FIXTURES_DIR=/fixtures` in `.env` and run `docker compose up -d`. The sidecar then serves `fixtures/calendar/events.json`. Copy `fixtures/transcripts/2026-10-04_1401.md` into your transcripts folder to run the §41 scenario. Unset the variable afterwards.

## Configuration

| File | Purpose | In git |
|---|---|---|
| `.env` | host paths, user IDs, vault folders, subnets | no (`.env.example`) |
| `config/system.yaml` | ops-mcp: timezone, your names and emails, transcript roots, cutoff, vault roots, thresholds | no (`*.example.yaml`) |
| `config/routing.yaml` | meeting → note rules | no |
| `config/paperclip.yaml` | company, labels, agents, routines and schedules, MCP servers, Codex hardening | no |
| `config/agents/*.md` | agent instructions (system prompts) | yes |
| `~/.config/pennyworth/` | secrets (0700 dir, 0600 files): Paperclip auth/JWT secrets, board and agent keys, MCP tokens, webhook secret, Google token | never |
| `data/` | Paperclip DB and workspaces, ops-mcp SQLite | no |

`transcripts.ignore_before` in `config/system.yaml` is set to 2026-10-05, so your existing transcripts are not backfilled. Remove it, or set an earlier date, to backfill. Each old meeting is then matched and published like a new one.

## Security model (short)

- Paperclip has no vault, transcript or home mounts and no Docker socket, and listens on loopback only.
- ops-mcp is the only vault writer. It sees only the configured vault folders, can't delete or replace notes, and has no Internet route.
- Agents run Codex with its read-only sandbox. Shell, browser, computer-use and ChatGPT app connectors are disabled. Agents act only through ops-mcp, read-only Google tools, and Paperclip task updates.
- No component can send email or Slack messages, or write to Calendar, Drive or GitHub.
- Source content is treated as untrusted. Model output is schema-validated and escaped before it reaches markdown, so it can't forge markers or headings.

`scripts/verify-security.sh` checks the mechanical parts of SPECS §40. Known gaps and trade-offs are listed in [`docs/DECISIONS.md`](docs/DECISIONS.md) (rootful Docker on this host, direct MCP delivery to Codex).

## Layout

```text
compose.yaml                 stack definition (pinned Paperclip image)
config/                      examples + agent instructions (local copies are gitignored)
services/ops-mcp/            TypeScript MCP service: ingestion, matcher, vault writer, routing, tasks, tests
services/google-workspace-mcp/  read-only Calendar/Drive MCP sidecar (+ fixture mode, consent helper)
services/paperclip-tasks-mcp/   stdio bridge so sandboxed agents can update Paperclip tasks
scripts/                     bootstrap, setup, health, backup/restore, security checks, watcher trigger
nix/                         opt-in Home Manager watcher module and NixOS notes
fixtures/                    calendar events, transcripts and a vault note for tests and demos
docs/                        spec, decisions
```
