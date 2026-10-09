<p align="center">
  <img src="docs/pennyworth_sm.png" alt="Pennyworth" width="160">
</p>

# Pennyworth

A local-first personal executive assistant. It runs on your own machine, reads your meetings, calendar, Slack and labelled email, and turns them into meeting notes in Obsidian and a single task list you work from a board. It also does research and drafting on request, and runs coding jobs in your repositories when you ask in plain words.

It is built on [Paperclip](https://github.com/paperclipai/paperclip) (agents, tasks, routines) with Codex agents, Obsidian as long-term memory, and small deterministic services in between. It was built for one person's workflow and is opinionated about it: read-only access to every source, nothing is ever sent on your behalf, and judgement stays in agents while matching, routing, writing and deduplication stay in code.

- **Meetings:** transcripts (local files, or Google Meet transcripts and Gemini notes in Drive) are matched to Calendar events. Pennyworth writes a canonical meeting note, appends a dated entry to the right project note, and creates tasks for your own action items.
- **Slack:** messages waiting on your reply, and things you promised, become tasks. They close themselves once you answer, or once you review the PR you were asked about.
- **Telegram:** mentions and replies to you in your client chats, and things you promised there, become tasks, through your organization's Telegram MCP (optional).
- **Email:** threads you label `pennyworth` in Gmail become tasks, and close when you remove the label.
- **Daily brief:** every weekday morning, a ranked view of your day: priorities, meetings, what's stale.
- **Assistant:** research and drafts (agendas, summaries) from Slack, Drive, Docs, Calendar and your notes, posted as task comments for you to review. It also acts on your replies to any task.
- **Coding jobs:** assign a task to an Engineer and say what you want. Codex, Claude Code or an OpenRouter model works in its own git worktree, as you, and nothing is pushed until you say `push` or `pr`.
- **Board:** a keyboard-driven task board on localhost, also usable from a paired phone at home.

All writes are idempotent, and nothing ambiguous is written. [`docs/SPECS.md`](docs/SPECS.md) is the original spec, and [`docs/DECISIONS.md`](docs/DECISIONS.md) (D-1 to D-27) explains every deviation from it.

```text
host (Linux, systemd user services)
├── pennyworth-runner (systemd --user, runs as you)       services/runner/
│     engineer tasks → Codex / Claude Code / OpenRouter jobs in its own worktrees
│     your replies on tasks → the Assistant; review-request tasks → closed from GitHub
├── transcript watcher (systemd --user .path) ── signed webhook ──► "Meeting scan"
└── docker compose (all containers: non-root, cap_drop ALL, no-new-privileges)
    ├── paperclip              127.0.0.1:3100 only; Codex agents (read-only sandbox, no shell)
    ├── ops-mcp                no Internet route; SQLite state; the only Obsidian writer
    ├── google-workspace-mcp   Calendar, Drive, Docs, Gmail: read-only scopes, GET requests only
    ├── slack-mcp              read-only proxy to Slack's official MCP server
    ├── telegram-mcp           read-only proxy to a Telegram MCP; scans your chats for mentions in the background
    └── board                  127.0.0.1:3120 task board (optional LAN listener for paired phones)
services/paperclip-tasks-mcp   stdio bridge, mounted into paperclip, for agents' task updates
```

## Requirements

- Linux with systemd user services, and Docker with Compose. NixOS is what it's developed on; [`nix/`](nix/) has opt-in modules, and plain unit files work too.
- Node.js 24 on the host (scripts and the runner).
- A ChatGPT account for Codex (the Paperclip agents).
- An Obsidian vault (any folder of markdown works).
- A Google Workspace account where you can create an OAuth client.
- Optional: Slack (a public OAuth client registered for your workspace), `gh` and Codex/Claude Code/opencode on the host for coding jobs, an OpenRouter key, Tailscale for the board away from home.

## Setup

1. **Configure.** `cp .env.example .env` and set the host paths: secrets directory, transcripts folder, vault and the vault folders Pennyworth may see. Then:

   ```sh
   scripts/bootstrap.sh            # secrets in ~/.config/pennyworth, config files from config/*.example.yaml, data dirs, vault mounts
   docker compose up -d --build
   ```

   Edit the generated `config/system.yaml` (your names and emails, timezone, transcript roots), `config/paperclip.yaml` (agents, schedules, tools) and `config/routing.yaml`. They are gitignored.

2. **Create your Paperclip account and provision everything.** This prompts for an email and password, claims the instance, and creates the company, labels, agents, routines and webhook. It's idempotent: re-run it after any change to `config/paperclip.yaml` or `config/agents/*.md`.

   ```sh
   node scripts/paperclip-setup.mjs
   ```

   Afterwards set `PAPERCLIP_DISABLE_SIGN_UP=true` in `.env` and run `docker compose up -d`.

3. **Log Codex in** (device flow, once):

   ```sh
   docker compose exec -it -u node paperclip codex -c 'cli_auth_credentials_store="file"' login --device-auth
   ```

   The `-u node` matters: the server must be able to read the resulting `/paperclip/.codex/auth.json`.

4. **Connect Google** (see [Google](#google)) and, optionally, [Slack](#slack).

5. **Install the transcript watcher** with the snippet in [`nix/README.md`](nix/README.md) (Home Manager, or two plain unit files).

6. **Install the runner** if you want coding jobs and reply handling. Edit `config/runner.yaml` (allowed GitHub orgs, engines, devshells), then run `services/runner/src/main.mjs` as a systemd user service:

   ```ini
   # ~/.config/systemd/user/pennyworth-runner.service
   [Unit]
   Description=Pennyworth runner
   After=network-online.target

   [Service]
   ExecStart=/usr/bin/env node --disable-warning=ExperimentalWarning /path/to/pennyworth/services/runner/src/main.mjs
   Restart=on-failure
   RestartSec=30

   [Install]
   WantedBy=default.target
   ```

   Make sure its `PATH` has `git`, `gh` and the engines you use.

7. **Check:** `scripts/healthcheck.sh` should be all green, and `scripts/verify-security.sh` should pass.

Then drop a transcript into your transcripts folder, or have a Meet call that produces one, and watch the **Meeting scan** task in Paperclip at <http://localhost:3100>, or the board at <http://localhost:3120>.

**Trying it without Google:** set `GOOGLE_FIXTURES_DIR=/fixtures` in `.env` and run `docker compose up -d`. The sidecar then serves `fixtures/calendar/events.json`; copy `fixtures/transcripts/2026-10-04_1401.md` into your transcripts folder. Unset the variable afterwards.

## Commands

| | |
|---|---|
| Start / stop | `docker compose up -d` / `docker compose down` (no agent keeps running on the host) |
| Health | `scripts/healthcheck.sh` |
| Security checks | `scripts/verify-security.sh` (containers, ports, egress, and a secret scan of the repo) |
| Backup / restore | `scripts/backup.sh` / `scripts/restore.sh <archive>` (restore refuses while running) |
| Re-apply Paperclip config | `node scripts/paperclip-setup.mjs` |
| Run the meeting scan now | `scripts/trigger-meeting-scan.sh` |
| Todo list in the terminal | `scripts/todo.mjs` (see [Todo list](#todo-list)) |
| Logs | `docker compose logs -f ops-mcp` (structured; no transcript text, no secrets), `journalctl --user -u pennyworth-runner -f` |
| Tests | `npm test --prefix services/<ops-mcp\|google-workspace-mcp\|slack-mcp\|telegram-mcp\|board\|runner>` |
| Intake evaluation | `npm run eval:intake --prefix services/runner` (real comments against the request reader; see `config/intake-cases.example.yaml`) |

[`AGENTS.md`](AGENTS.md) has the deploy commands per service, debugging recipes and the pitfalls found so far.

## Agents

| Agent | Runs | Can use |
|---|---|---|
| Meeting Librarian | file watcher + every 15 min in work hours | ops-mcp; Calendar/Drive read; its own tasks |
| Chief of Staff | weekdays 08:30 → "Daily Brief — date" | Calendar read; Paperclip task list/create/update |
| Slack Scout | every 30 min in work hours | Slack read/search; Paperclip task search/create/update/close |
| Telegram Scout | every 30 min in work hours | Telegram read (allowed chats) and prepared mention candidates; Paperclip task search/create/update/close |
| Inbox Agent | every 30 min in work hours: one task per Gmail thread labelled `pennyworth` (archived or not), closed when the label is removed | Gmail read/search; Paperclip task search/create/update/close |
| Assistant | when assigned, and on your task replies | Slack/Docs/Drive/Calendar read; notes read + meeting-note corrections; cached web search; Paperclip tasks |
| Engineer · Codex / · Claude / · GLM | never woken: assignment targets for the runner | none (the runner does the work) |

Each agent sees only the MCP servers and tools listed for it in `config/paperclip.yaml` (`mcp_servers`, `enabled_tools`); everything else is disabled in its Codex arguments. Schedules live there too. Run a routine on demand with **Run now** in Paperclip.

Every task Pennyworth creates is assigned to you, and only for *your own* clear actions. Other people's commitments stay in the meeting notes.

## How meeting processing works

1. **Wake-up.** The watcher, or the 15-minute schedule, fires the *Meeting scan* routine, which wakes the Meeting Librarian.
2. **Scan.** `transcripts_scan` registers new or changed files (by canonical path and SHA-256; a changed file is a new revision) once they've been stable for `stability_seconds`. Meet transcripts and Gemini notes are found in Drive.
3. **Match.** The agent reads the calendar around each item and passes the events to `meeting_match`. ops-mcp scores each candidate:

   | Component | Points |
   |---|---|
   | Time | 0–50 |
   | Title | 0–20 |
   | People | 0–15 |
   | Filename | 0–10 |
   | Meet link / location | 0–5 |

   **≥ 75 and unambiguous:** matched. **55–74, or ambiguous:** a review task. **< 55:** unmatched, retried later. A Drive document attached to exactly one event matches it directly. A local recording whose audio is still next to it matches the event it sits inside (at least 60% of the recording, and no other event with 30% or more), even with no other evidence. Events you declined still count: Gemini notes are shared for those too.
4. **Publish.** The agent reads the source and calls `meeting_publish` with a structured extraction (summary, explicit or probable decisions, actions with owner and deadline only when stated, open questions). ops-mcp then:
   - writes `Meetings/YYYY/MM/YYYY-MM-DD HHMM - Title.md`, tagged `type/meeting` (search `tag:#type/meeting` in Obsidian);
   - routes the meeting: explicit rules in `config/routing.yaml`, then remembered choices, then topic keywords, else the agent's best guess of an existing project note (or none). It never asks you;
   - appends a Meeting Log entry with a `<!-- paperclip-meeting:<event id> -->` marker (never twice);
   - creates tasks for your own action items;
   - renames a recorder-named transcript (`2026-10-08_11-01-59.txt`) after the meeting (`Dana-2026-10-08.txt`, 1:1s into `1-1s/`) and deletes its audio. Files you named yourself keep their names.

**Review tasks:** comment `pick 2` (number from the list) or `ignore`, then wait for the next scan or click **Run now**.

**Routing:** explicit regex rules in `config/routing.yaml` always win, so add one to correct a wrong guess. Targets must be existing notes in the mounted vault folders.

## Board

**http://localhost:3120** is where you work your tasks. It shows every open task assigned to you, the Assistant or an Engineer, in five columns:

- **Triage**: every new task lands here (from Slack, email, meetings, or added on the board).
- **Today**, **Tomorrow**, **Later**, **Backlog**: ranked top to bottom. At the start of each workday (Monday to Friday, set by `workdays` in `config/system.yaml`), Tomorrow moves into Today below what's left over, so Friday's Tomorrow lands on Monday. Leftovers show how many days they've been carried over, and **Keep**, **→ Tomorrow** or **→ Later** at the top of Today handles them all at once.

Drag cards to rank or move them (on a phone, use a card's arrow). Open a card to edit it, change priority, status and labels, reassign it (to an Engineer with model and effort), read the thread and reply, or close it with undo. Task references such as `PEN-12` in text open the task and show its status. **Brief** opens today's Daily Brief; **Done** shows the last 48 hours.

Keyboard: `j`/`k` and `h`/`l` (or arrows) to move, `Enter` to open, `e` done, `1`–`5` to move to Triage…Backlog, `J`/`K` to rank, `c` new task, `/` search, `b` brief, `r` recurring, `?` for the rest.

**On a date, or on repeat:**
- **Bring back** in a task's sheet puts it on top of Today (or another column) on a date.
- **Repeats** makes it a recurring task: weekly, every N weeks, monthly on a date or on a weekday such as the first Monday, at a time (07:00 by default). Each run, the Assistant follows the task's description. It reads the Slack channels, documents, meeting notes and GitHub repositories the description names, for the period since the last run, and puts the result on top of your Today as a new task, ready to paste. Recurring tasks live under **Recurring**, with Run now, Pause and Stop.
- Both also work in plain words in a comment: "bring this back next Tuesday", "make this repeat every Monday at 8".

Bucket and rank live in the board's own SQLite (`data/board/`); everything else is the Paperclip task. The board acts as you with a board key that stays in the container, listens on 127.0.0.1 only, and refuses other host names and cross-site requests.

**On your phone, at home:** set `BOARD_LAN_CLIENTS` to your home subnet (e.g. `192.168.1.0/24`), `BOARD_LAN_BIND=0.0.0.0` and `BOARD_LAN_PORT=80` in `.env`, then `docker compose up -d board`. Click **Phone** on the laptop's board and enter the code shown at http://pennyworth.local on the phone (or scan the QR code). Only paired devices get in; remove them in the same panel. The name is published over mDNS by [`nix/board-mdns.nix`](nix/board-mdns.nix) while you're on the home Wi-Fi. It's plain HTTP, so only enable it on networks you trust. Some VPN firewalls block LAN traffic while connected.

**Away from home:** `tailscale serve --bg --https=443 http://127.0.0.1:3121`, with the tailnet name added to `BOARD_LAN_HOSTS` and `100.64.0.0/10` to `BOARD_LAN_CLIENTS`.

## Todo list

```sh
todo                                 # open todos + meeting actions, by priority
todo add "Draft the Q4 roadmap" -p high -n "for Thursday's review"
todo prio PEN-12 critical            # critical | high | medium | low
todo done PEN-12 "sent to Alice"
todo show PEN-12
todo waiting                         # what other people owe you
todo brief                           # today's daily brief
todo --all                           # include reviews and briefs
```

`todo` is `scripts/todo.mjs`; alias or symlink it onto your PATH. The Chief of Staff ranks the list every weekday morning in the **Daily Brief** task. It only *suggests* priority changes; you decide.

## Assistant

For anything that isn't code: research, drafts, and acting on your replies.

- **Assign a task to the Assistant**, e.g. "Update the agenda for today's partner call from #ext-… and the previous agendas doc". It reads Slack, Google Docs (all tabs), Drive, Calendar, your notes and public web pages (from a search cache, never live). It posts the deliverable as a comment for you to review and paste, then assigns the task back to you.
- **Reply on any of your tasks.** About 90 seconds after your last comment, the runner hands it to the Assistant, which acts on clear intent: fixes names and details in the task and in the meeting notes Pennyworth wrote, records context, closes the task ("done", "not relevant"), or answers questions. It replies with one line saying what changed.
- **Work across many repositories:** ask it to open an Engineer sub-task per repository. Reply "go" on the parent to start them all, then **pr** on the parent to open every PR (D-24).

It never sends messages and never edits Slack, Docs or Calendar.

## Coding jobs

Comment on a task and the work happens in a repository on this machine, the way you'd run an agent in a terminal tab, but tracked in Paperclip.

1. **Assign the task to an Engineer.** The Engineer picks the engine: **Engineer · Codex**, **Engineer · Claude** (Claude Code) or **Engineer · GLM** (OpenRouter through opencode). To pick the model and effort too, switch the assignee's **Model lane** to **Override**. Tasks you wrote start right away. Tasks Pennyworth created from Slack, email or meetings wait for your comment, because their text is other people's words.
2. **Say what you want, in plain words:** which repository (link or org/name), any reference repositories, whether you want an answer, a report/spec or the change itself, and optionally an engine or model ("use Claude", "use GLM"). A short model call reads the request; code checks its answer against the repositories you mentioned and the known models, and asks you if it can't tell. There's no syntax to learn.
3. **The runner picks it up** within about 20 seconds. It clones the repo into `~/pennyworth/repos`, creates a worktree on branch `pennyworth/<task>`, runs the engine inside your devshells under Codex's sandbox (writes only in the worktree and build caches), posts the report on the task and sets it to *in review*. In implement mode it commits with a conventional commit message.
4. **Follow-ups** continue the same session in the same worktree. If the PR was merged meanwhile, the work moves to a fresh branch from the latest base.

You can also talk about the run itself: "stop that", "how's it going?", "start over", "we're done, clean up".

Publishing takes the exact word, as a comment on its own:

| Command | What it does |
|---|---|
| `push` | publish `pennyworth/<task>` to GitHub (never forced). An empty repository gets the work as its first commit on `main` |
| `pr` | push and open a **draft** PR, with a title and description written for the repository's reviewers |

Agents can't push or write to GitHub themselves: `gh` is wrapped read-only, pushes are disabled in the runner's clones, a pre-push hook and an ssh wrapper both refuse them, and after each run the runner checks that nothing appeared on GitHub. Only *your* comments are instructions.

Engine credentials live in `~/.config/pennyworth/` (0600): `openrouter_key` for OpenRouter, and `claude_oauth_token` from `claude setup-token` for Claude Code. Claude Code runs in a runner-owned home with no settings, MCP servers, plugins or connectors, a fixed tool allowlist, and `codex sandbox` around the whole process.

## Slack

Pennyworth reads Slack through Slack's official MCP server (`mcp.slack.com`). That server has no dynamic client registration, so you need a public OAuth client registered for your workspace, with callback `http://localhost:3118/callback`. Set its ID as `SLACK_CLIENT_ID` in `.env`, then:

```sh
scripts/slack-auth.sh              # once: open the printed URL and approve
node scripts/paperclip-setup.mjs   # activates the Slack scan routine
```

The `slack-mcp` sidecar holds your user token, refreshes it (Slack rotates refresh tokens), and exposes **only** read tools. Send, draft, schedule, react, canvas and list tools are never listed, and are refused if called. Consent asks only for read and search scopes.

The Slack Scout creates two kinds of tasks, each with a permalink and a `source:slack:<channel>:<ts>` marker so nothing is duplicated:

- `needs-response`: someone is waiting for your reply. It closes once you answer in the thread. A request to review a GitHub PR closes once you've reviewed it, or it's merged or closed (the runner checks with read-only `gh`).
- `todo`: something you promised.

## Telegram

Optional. Pennyworth reads Telegram through your organization's Telegram MCP server, one that holds your own Telegram session and an allowlist of chats you pick, and supports OAuth with dynamic client registration ([D-27](docs/DECISIONS.md)). Set its endpoint as `TELEGRAM_MCP_URL` and who you are (`TELEGRAM_ME_NAMES`, `TELEGRAM_ME_HANDLES`, `TELEGRAM_ME_ALIASES`) in `.env`, then:

```sh
scripts/telegram-auth.sh           # once: open the printed URL, sign in, link Telegram, pick your chats
node scripts/paperclip-setup.mjs   # activates the Telegram scan routine
```

The callback is `http://localhost:3119/callback`, so open the URL on the machine running Pennyworth. Pennyworth sees only the chats you picked; add new ones in the server's chat picker.

The `telegram-mcp` sidecar exposes only read tools: drafting and changing the chat allowlist are never listed. It scans your chats every 15 minutes (the server takes seconds per call), keeping only cursors and message IDs on disk. It finds mentions of you by handle or name, replies to your messages, DMs and your own messages. The Telegram Scout decides which need a task, using the Slack Scout's rules, and closes a `needs-response` task once you've replied in the chat.

## Google

Pennyworth uses its own read-only sidecar (`services/google-workspace-mcp`) rather than Paperclip's Google connector ([D-9](docs/DECISIONS.md)).

1. In a Google Cloud project under your Workspace account, enable the **Calendar**, **Drive**, **Docs** and **Gmail** APIs.
2. Configure the OAuth consent screen (*Internal* if your Workspace allows it) and create an OAuth client of type **Desktop app**.
3. Run `scripts/google-auth.sh <client json>` (or no argument, to paste the ID and secret) and approve in the browser. The only scopes are `calendar.events.readonly`, `drive.readonly` and `gmail.readonly`. The refresh token goes to `~/.config/pennyworth/google_oauth.json` (0600) and is mounted into the sidecar only.

**Several accounts:** `scripts/google-auth.sh --email you@work.com --primary` for the account whose Calendar and Meet transcripts Pennyworth should use, then `scripts/google-auth.sh --email you@other.com` for each extra account. Gmail and Drive cover every connected account.

If Workspace policy blocks consent, nothing else breaks: matching reports "calendar unavailable" and sources stay pending. Don't weaken Workspace settings to work around it, and check your organization's policy before connecting work accounts.

## Configuration

| File | Purpose | In git |
|---|---|---|
| `.env` | host paths, user IDs, vault folders, board LAN settings, Slack client ID, Telegram endpoint and your names there | no (`.env.example`) |
| `config/system.yaml` | ops-mcp: timezone, your names and emails, transcript roots, cutoff, vault roots, thresholds | no (`system.example.yaml`) |
| `config/routing.yaml` | meeting → note rules | no (`routing.example.yaml`) |
| `config/paperclip.yaml` | company, labels, agents, routines and schedules, MCP servers, Codex hardening | no (`paperclip.example.yaml`) |
| `config/runner.yaml` | runner: allowed orgs, engines, devshells, limits | no (`runner.example.yaml`) |
| `config/agents/*.md` | agent instructions (system prompts) | yes |
| `~/.config/pennyworth/` | secrets (0700 dir, 0600 files): Paperclip secrets, board and agent keys, MCP tokens, webhook secret, Google/Slack/engine tokens | never |
| `data/` | Paperclip DB and workspaces, ops-mcp and board SQLite | no |

`transcripts.ignore_before` in `config/system.yaml` stops existing transcripts from being backfilled. Remove it, or set an earlier date, to backfill.

## Security model

- Paperclip has no vault, transcript or home mounts and no Docker socket, and listens on loopback only.
- ops-mcp is the only vault writer. It sees only the configured vault folders, can't delete or replace notes, and has no Internet route.
- Agents run Codex with its read-only sandbox; shell, browser, computer-use and app connectors are disabled, and live web search is never combined with private-data tools. Agents act only through ops-mcp, read-only Google and Slack tools, and Paperclip task updates.
- No component can send email or Slack messages, or write to Calendar, Drive or Docs. Only your exact `push`/`pr` reaches GitHub.
- Source content is untrusted: every agent prompt says so, and model output is schema-validated and escaped before it reaches markdown, so it can't forge markers or headings.

`scripts/verify-security.sh` checks the mechanical parts. Known gaps and trade-offs (rootful Docker, direct MCP delivery to Codex) are in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Layout

```text
compose.yaml                    stack definition (pinned Paperclip image)
config/                         examples + agent instructions (local copies are gitignored)
services/ops-mcp/               TypeScript MCP service: ingestion, matcher, vault writer, routing, tasks
services/google-workspace-mcp/  read-only Calendar/Drive/Docs/Gmail MCP sidecar (+ fixture mode, consent helper)
services/slack-mcp/             read-only proxy to mcp.slack.com
services/board/                 task board: server + web app
services/runner/                host service for coding jobs, replies and review-request tasks
services/paperclip-tasks-mcp/   stdio bridge so sandboxed agents can update Paperclip tasks
scripts/                        bootstrap, setup, health, backup/restore, security checks, auth helpers, todo CLI
nix/                            opt-in Home Manager watcher and mDNS modules
fixtures/                       calendar events, transcripts and a vault note for tests and demos
docs/                           spec and decisions
```

## License

[MIT](LICENSE)
