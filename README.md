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
   - routes the meeting: explicit rules, then remembered choices, then topic keywords, else the agent's best guess of an existing project note (or none). It never asks you;
   - appends the Meeting Log entry with a `<!-- paperclip-meeting:<event id> -->` marker (never twice);
   - creates action tasks with markers: `meeting-action` for yours, `waiting-on` for other people's.

### Resolving review tasks

Comment on the task in Paperclip, then wait for the next scan, or click **Run now** on the Meeting scan routine:

- **Which meeting was this?** `pick 2` (number from the list) or `ignore`.

### Routing rules

Edit `config/routing.yaml` (examples inside). Explicit regex rules always win, so add one to correct a wrong guess. Targets must be existing notes in the mounted vault folders.

## Board

**http://localhost:3120** is where you work your tasks. It shows every open task assigned to you, the Assistant or an Engineer, in five columns:

- **Triage**: every new task lands here (from Slack, email, meetings, or added on the board). Sort it into one of the others.
- **Today**, **Tomorrow**, **Later**, **Backlog**: ranked top to bottom. At midnight (your `timezone` in `config/system.yaml`), Tomorrow moves into Today, below what's still there.

Drag cards to rank or move them; on a phone, use a card's arrow. Open a card to do everything else: edit the title and description, change priority, status and labels, assign it to yourself, the Assistant or an Engineer (with model and effort), read the whole thread and reply, and mark it done or cancelled (with undo). Replies reach the same handlers as before (the Assistant, the runner or the review flow); the box says which. **Brief** opens today's Daily Brief. Task references there (and in descriptions and comments) open the task and show its status: ✓ struck through when done, ✕ when cancelled, a half-filled dot while in progress; hover for the title. **Done** shows what closed in the last 48 hours, so you can reopen it.

Keyboard: `j`/`k` and `h`/`l` (or arrows) to move around, `Enter` to open, `e` done, `1`–`5` to move to Triage…Backlog, `J`/`K` to rank, `c` new task, `/` search, `b` brief, `?` for the rest.

Bucket and rank are the board's own (`data/board/board.sqlite`); everything else is the Paperclip task. The board acts as you with the board key, which stays in the container; it's published on 127.0.0.1 only and refuses requests for other host names or from other sites.

**On your phone, at home:** the board is at **http://pennyworth.local** on the home Wi-Fi, for paired devices only. Click **Phone** on the laptop's board and scan the QR code; the phone stays paired (remove devices in the same panel). Add the page to your home screen for an app-like icon.

- Setup: in `.env`, `BOARD_LAN_CLIENTS=192.168.7.0/24` (your home subnet; nothing else may connect), `BOARD_LAN_BIND=0.0.0.0` and `BOARD_LAN_PORT=80`, then `docker compose up -d board`. The name comes from the NixOS module `nix/board-mdns.nix` (vendored into `~/config/nixos/modules/pennyworth-mdns.nix`, `services.pennyworth-mdns = { enable = true; ssid = "…"; }`, plus `services.avahi.publish.userServices = true`), which publishes it over mDNS only while the laptop is on that Wi-Fi.
- It's plain HTTP: fine on your own Wi-Fi, but don't open it on networks you don't trust. NordVPN's firewall blocks LAN traffic while connected unless `nordvpn set lan-discovery on`.
- Away from home: `tailscale serve --bg --https=443 http://127.0.0.1:3121`, with the tailnet name added to `BOARD_LAN_HOSTS` and the tailnet range (`100.64.0.0/10`) to `BOARD_LAN_CLIENTS`.

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
| Inbox Agent | every 30 min, weekdays 08–19: one todo per email thread you label `pennyworth` in Gmail (archived or not), closed when you remove the label | Gmail read/search only; Paperclip task search/create/update/close |
| Assistant | when assigned, and on your task replies | Slack/Docs/Drive/Calendar read; notes read + meeting-note corrections; Paperclip tasks incl. hand-back |
| pennyworth-runner (host service, not a Paperclip agent) | your comments on `engineer` tasks | Codex, Claude Code or OpenRouter (picked by the Engineer the task is assigned to) in its own git worktrees, as you; read-only gh; no pushes except your `push`/`pr` |

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

1. Assign the task to an Engineer, or add the label **engineer**. The Engineer picks the engine: **Engineer · Codex**, **Engineer · Claude** (Claude Code, Opus 5.5 by default) or **Engineer · GLM** (OpenRouter through opencode). To pick the model and thinking effort too, open the task's assignee options and switch **Model lane** to **Override**. Without an override, the Engineer's primary model is used; you can change that on the agent's page. Codex and Claude Code use the effort setting; GLM ignores it. If you wrote the task yourself, its title and description are the request and work starts right away. Tasks Pennyworth created (from Slack, email or meetings) wait for your comment: their descriptions are other people's words, so they're never taken as instructions.
2. Comment with what you want, in plain words: which repository to work in (link or org/name), any repositories to use as references, whether you want a report/spec first or the change made, and optionally an engine or model ("use the astra model", "use Claude", "use opus", "use GLM"). Naming one moves the task to the matching Engineer and model, so the task always shows what runs it. A short Codex call reads the request; the runner checks its answers against the repositories you mentioned and the known models, and asks you in plain words if it can't tell which repository you mean (reply with just the name). Reference repositories are cloned read-only next to the worktree. Empty repositories work too: the task branch starts from scratch.

   Each comment is judged on its own: a question gets a direct answer and no code changes, a request for research, a review or a spec gets a report, and only an explicit request for changes gets them. Short follow-ups such as "continue" keep the previous kind.

3. The **pennyworth-runner** service (systemd user service, runs as you) picks it up within about 20 seconds:
   - it clones the repo into `~/pennyworth/repos` and creates the worktree `~/pennyworth/tasks/<TASK>-<repo>` on branch `pennyworth/<task>`;
   - it runs the engine inside the devshells, with Codex's sandbox (writes only in the worktree and build caches);
   - it posts the report on the task and sets the status to *in review*.

   In implement mode, the runner commits the changes with the agent's proposed conventional commit message.
4. Follow-up comments continue the same agent session in the same worktree. If the task's PR has been merged in the meantime, the work moves to a new branch (`pennyworth/<task>-2`, …) from the latest base branch, carrying over any commits made since the merge, and **pr** opens a new PR. If the PR was closed without merging, **pr** opens a new one from the same branch.

You can also just say what you want about the run itself: "stop that", "how's it going?", "start over with a fresh conversation", "we're done, clean up". The same short Codex call reads these. Clean-up refuses while there are uncommitted changes.

Publishing takes the exact word, as a comment on its own. If you write "looks good, push it", the runner asks you to reply with the word:

| Command | What it does |
|---|---|
| `push` | publish `pennyworth/<task>` to GitHub (never forced). Exception: if the repository is still empty, the work becomes its first commit on `main` (the first branch pushed to an empty repo becomes its default) |
| `pr` | push and open a **draft** PR with the report as description |

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

Claude Code jobs use a long-lived subscription token, not your interactive login: run `claude setup-token` once and save the token it prints to `~/.config/pennyworth/claude_oauth_token` (0600). They run in a runner-owned Claude home (`~/.local/state/pennyworth-runner/claude`) with no settings files, MCP servers, plugins or claude.ai connectors, a fixed set of built-in tools (shell, files, web, subagents), and `codex sandbox` around the whole process.

## Slack

Pennyworth reads Slack through Slack's official MCP server (`mcp.slack.com`). It uses Polygon's registered OAuth client from go/mcps, a public client with callback `http://localhost:3118/callback`, set as `SLACK_CLIENT_ID` in `.env`.

- The `slack-mcp` sidecar holds your user token, refreshes it (Slack rotates refresh tokens), and exposes **only** read tools: search, read channel/thread, user and channel lookups. Send, draft, schedule, react, canvas and list tools are never listed, and are refused if called.
- Consent asks only for read and search scopes.

```sh
scripts/slack-auth.sh         # once: open the printed URL, approve; then:
node scripts/paperclip-setup.mjs   # re-activates the Slack scan routine
```

The Slack Scout creates two kinds of tasks:

- `needs-response`: someone is waiting for your reply. It is closed automatically once you answer in the thread. A request to review a GitHub PR also closes once you've submitted a review on GitHub after the ask, or the PR is merged (done) or closed (cancelled). The runner checks every 5 minutes with read-only `gh` queries and comments with what it saw.
- `todo`: something you promised.

Every task carries a permalink and the marker `source:slack:<channel>:<ts>`, so nothing is duplicated. `todo` lists the needs-response items as `reply`.

## Google

Pennyworth uses its own read-only sidecar (`services/google-workspace-mcp`). Paperclip's native Google connector depends on Google's Developer Preview enrollment ([D-9](docs/DECISIONS.md)).

1. In a Google Cloud project under your Workspace account, enable the **Google Calendar API** and the **Google Drive API**.
2. Configure the OAuth consent screen as *Internal* if your Workspace allows it.
3. Create an OAuth client of type **Desktop app** and download its JSON.
4. Enable the **Gmail API** and **Google Docs API** too. Run `scripts/google-auth.sh <that json>` (or `scripts/google-auth.sh` with no argument to paste the client ID and secret instead) and approve in the browser. The only scopes requested are `calendar.events.readonly`, `drive.readonly` and `gmail.readonly`. Re-run `scripts/google-auth.sh` without arguments after scopes change; it reuses the client on file. The refresh token goes to `~/.config/pennyworth/google_oauth.json` (0600) and is mounted into the sidecar only.

**Several accounts:** run `scripts/google-auth.sh --email you@work.com --primary` for the account whose Calendar and Meet transcripts Pennyworth should use, then `scripts/google-auth.sh --email you@other.com` for each extra account. Gmail inboxes and Drive search cover every connected account; tasks note which account an email came from.

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
