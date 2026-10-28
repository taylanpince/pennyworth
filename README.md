<p align="center">
  <img src="docs/pennyworth_sm.png" alt="Pennyworth" width="160">
</p>

# Pennyworth

A local-first personal executive assistant. It runs on your own machine, reads your meetings, calendar, Slack and labelled email, and turns them into meeting notes in Obsidian and a single task list you work from a board. It also does research and drafting on request, and runs coding jobs in your repositories when you ask in plain words.

It is built on [Paperclip](https://github.com/paperclipai/paperclip) (agents, tasks, routines) with Codex agents, Obsidian as long-term memory, and small deterministic services in between. It was built for one person's workflow and is opinionated about it: read-only access to every source, nothing is ever sent on your behalf, and judgement stays in agents while matching, routing, writing and deduplication stay in code.

- **Meetings:** transcripts (local files, or Google Meet transcripts and Gemini notes in Drive) are matched to Calendar events. Pennyworth writes a canonical meeting note, appends a dated entry to the right project note, and creates tasks for your own action items.
- **Slack:** messages waiting on your reply, and things you promised, become tasks. They close themselves once you answer, or once you review the PR you were asked about.
- **Telegram:** mentions and replies to you in your chats, DMs, and things you promised there, become tasks, through your own Telegram session, read-only (optional).
- **Email:** threads you label `pennyworth` in Gmail become tasks, and close when you remove the label.
- **Daily brief:** every weekday morning, a ranked view of your day: priorities, meetings, what's stale.
- **Assistant:** research and drafts (agendas, summaries) from Slack, Drive, Docs, Calendar and your notes, posted as task comments for you to review. It also acts on your replies to any task, and learns how you write when you ask it to (a voice guide note in your vault).
- **Coding jobs:** assign a task to an Engineer and say what you want. Codex, Claude Code or an OpenRouter model works in the task's own workspace, as you: several repositories, several branches and stacked branches in one task, and nothing is pushed until you say `push` or `pr`.
- **Board:** a keyboard-driven task board on localhost, also usable from a paired phone at home.

All writes are idempotent, and nothing ambiguous is written. [`docs/SPECS.md`](docs/SPECS.md) is the original spec, and [`docs/DECISIONS.md`](docs/DECISIONS.md) (D-1 to D-31) explains every deviation from it.

```text
host (Linux, systemd user services)
├── pennyworth-runner (systemd --user, runs as you)       services/runner/
│     engineer tasks → Codex / Claude Code / OpenRouter jobs in per-task workspaces
│     your replies on tasks → the Assistant; review-request tasks → closed from GitHub
├── transcript watcher (systemd --user .path) ── signed webhook ──► "Meeting scan"
└── docker compose (all containers: non-root, cap_drop ALL, no-new-privileges)
    ├── paperclip              127.0.0.1:3100 only; Codex agents (read-only sandbox, no shell)
    ├── ops-mcp                no Internet route; SQLite state; the only Obsidian writer; reference docs (read-only)
    ├── google-workspace-mcp   Calendar, Drive, Docs, Gmail: read-only scopes, GET requests only
    ├── slack-mcp              proxy to Slack's official MCP server: reads, plus drafts you send yourself
    ├── telegram-mcp           your own Telegram session, reads only; new messages arrive live
    ├── primer-mcp             proxy to your organization's Primer: read documents, publish when you ask
    ├── glean-mcp              proxy to your organization's Glean: company-wide search, reads only
    ├── github-mcp             GitHub issues and pull requests with your gh token: read; comment or open issues when you ask
    ├── grafana-mcp            proxy to Grafana Cloud's MCP server, read/query scopes only, for Engineer jobs (127.0.0.1:3124)
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
| Evaluations | `npm run eval:authorize`, `eval:busy` and `eval:intake` `--prefix services/runner`: real comments against the check on an Engineer's GitHub writes, the reader for comments during a run, and the go-ahead on sub-tasks (see `config/*-cases.example.yaml`) |

[`AGENTS.md`](AGENTS.md) has the deploy commands per service, debugging recipes and the pitfalls found so far.

## Agents

| Agent | Runs | Can use |
|---|---|---|
| Meeting Librarian | file watcher + every 15 min in work hours | ops-mcp; Calendar/Drive read; its own tasks |
| Chief of Staff | weekdays 08:30 → "Daily Brief — date" | Calendar read; Paperclip task list/create/update |
| Slack Scout | every 30 min in work hours | Slack read/search; Paperclip task search/create/update/close |
| Telegram Scout | every 30 min in work hours | Telegram read (your chats) and mention candidates; Paperclip task search/create/update/close |
| Inbox Agent | every 30 min in work hours: one task per Gmail thread labelled `pennyworth` (archived or not), closed when the label is removed | Gmail read/search; Paperclip task search/create/update/close |
| Assistant (Alfred) | when assigned, and on your task replies | Slack/Telegram/Docs/Drive/Calendar read; Glean search; reference docs; Primer read + publish when asked; GitHub issues/PRs read + comment and open issues when asked; notes read + meeting-note corrections; your writing voice guide, with lessons added when you ask; cached web search; Paperclip tasks |
| Engineer · Codex (Grace) / · Claude (Ada) / · OpenRouter (Linus) | never woken: assignment targets for the runner | none (the runner does the work) |

The agents you assign are your crew: each has a name, a portrait and a one-line voice (`persona` in `config/paperclip.yaml`, D-45). Naming one in a comment ("let Ada do it") picks that Engineer.

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

Drag cards to rank or move them (on a phone, use a card's arrow). Open a card to edit it, change priority, status and labels, reassign it (to an Engineer with model and effort), read the thread and reply, attach files, or close it with undo. Task references such as `PEN-12` in text open the task and show its status. **Brief** opens today's Daily Brief; **Done** shows the last 48 hours.

**Files as context:** **Attach** in a task's reply box (or paste or drop files there; on a phone, photos too) adds documents, logs, screenshots or notes to the task, up to 10 MB each. With a reply, the reply names them ("Attached: `spec.pdf`"), so the Assistant or the Engineer reads them with your request; without one, they wait on the task for the next request. The Assistant reads text, images, and PDFs through a text version the board makes; Engineer jobs find them in the workspace under `.pennyworth/files/`, sub-tasks with their parent's files too ([D-43](docs/DECISIONS.md)). Other formats (Word, Excel) are stored and handed to Engineer jobs, but the Assistant can't read them: attach a PDF instead.

When agents work on one of your tasks, they show on its card as portraits with a ring: green and turning while working, dashed while queued, amber when there's something for you to read or answer, red when a run got stuck, grey for an Engineer the Assistant proposed that waits for your go-ahead. Their sub-tasks don't get cards of their own; click a portrait to open that agent's work. **Needs you** in the top bar counts the agents waiting on you and opens the next one.

**Working with the crew.** **New task** (`c`) makes a task for you, or picks someone from the crew to start on it with your instructions. Open a task to see its **Overview** (description, files, a line from each agent, and the team chat that Alfred reads) and a tab per agent, with a direct chat: what you write in Ada's tab goes to Ada. **+ Add agent** brings someone else in with instructions; they see the task. When Alfred proposes an Engineer, it waits for your **Approve**; when an Engineer gets stuck, **Hand to Ada** passes your instructions to another one. **Details** holds priority, labels, bring back, repeats and Cancel task. **Done** closes the agents' parts too.

**Crew** (key `a`; on a phone, the first tab) switches to who is working on what: a tile for each crew member (Alfred, Grace, Ada, Linus) with the tasks they're on now, their queue and what they finished in the last 12 hours, then the background agents' runs (scans on request). On the board itself, a card an agent is working on carries a pulsing badge with the agent and elapsed time ("Assistant · 3m", "Codex · 12m"), or "Engineer queued". The status *In progress* alone doesn't mean anything is running.

Keyboard: `j`/`k` and `h`/`l` (or arrows) to move, `Enter` to open, `e` done, `1`–`5` to move to Triage…Backlog, `J`/`K` to rank, `c` new task, `/` search, `b` brief, `r` recurring, `?` for the rest.

**On a date, or on repeat:**
- **Bring back** in a task's sheet puts it on top of Today (or another column) on a date.
- **Snooze** (the clock on a card, or in the task view) parks a task in Backlog and brings it back on top of Today: tomorrow, in 2 days, later this week (Friday, on Mondays and Tuesdays), next week (Monday) or a date you pick.
- **Repeats** makes it a recurring task: weekly, every N weeks, monthly on a date or on a weekday such as the first Monday, at a time (07:00 by default). Each run, the Assistant follows the task's description. It reads the Slack channels, documents, meeting notes and GitHub repositories the description names, for the period since the last run, and puts the result on top of your Today as a new task, ready to paste. Recurring tasks live under **Recurring**, with Run now, Pause and Stop.
- Both also work in plain words in a comment: "bring this back next Tuesday", "make this repeat every Monday at 8".

Bucket and rank live in the board's own SQLite (`data/board/`); everything else is the Paperclip task. The board acts as you with a board key that stays in the container, listens on 127.0.0.1 only, and refuses other host names and cross-site requests.

**On your phone, at home:** set `BOARD_LAN_CLIENTS` to your home subnet (e.g. `192.168.1.0/24`), `BOARD_LAN_BIND=0.0.0.0` and `BOARD_LAN_PORT=80` in `.env`, then `docker compose up -d board`. Click **Phone** on the laptop's board and enter the code shown at http://pennyworth.local on the phone (or scan the QR code). Only paired devices get in; remove them in the same panel. The name is published over mDNS by [`nix/board-mdns.nix`](nix/board-mdns.nix) while you're on the home Wi-Fi. It's plain HTTP, so only enable it on networks you trust. Some VPN firewalls block LAN traffic while connected.

**Anywhere, over Tailscale:** run `tailscale serve --bg --https=443 http://127.0.0.1:<BOARD_LAN_PORT>`. Then add the tailnet name to `BOARD_LAN_HOSTS`, set `BOARD_LAN_URL=https://<machine>.<tailnet>.ts.net`, and add `10.231.1.1/32` to `BOARD_LAN_CLIENTS`. Tailscale's proxy connects over loopback, so requests reach the board from the egress network's gateway, not from the phone's tailnet address. Pair the phone at that URL and add it to the Home Screen from there. A home-screen app stays on the address it was added from, and `pennyworth.local` can't be reached over Tailscale, so use the tailnet URL on the phone and keep Tailscale on, at home too.

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

- **Assign a task to the Assistant**, e.g. "Update the agenda for today's partner call from #ext-… and the previous agendas doc". It reads Slack, your allowed Telegram chats, Glean, Google Docs (all tabs), Drive, Calendar, your notes, your reference docs and public web pages (from a search cache, never live). It posts the deliverable as a comment for you to review and paste, then assigns the task back to you.
- **Reply on any of your tasks.** About 90 seconds after your last comment, the runner hands it to the Assistant, which acts on clear intent: fixes names and details in the task and in the meeting notes Pennyworth wrote, records context, closes the task ("done", "not relevant"), or answers questions. It replies with one line saying what changed.
- **Work across many repositories at once:** one Engineer task can change several repositories itself (D-41). For a large fan-out (the same change in 20 repositories), ask the Assistant to open an Engineer sub-task per repository instead: they run in parallel with a report each. Reply "go" on the parent to start them all, then **pr** on the parent to open every PR (D-24).

It never sends messages and never edits Slack, Docs or Calendar. It publishes only to Primer and as GitHub comments and issues, and only when you ask.

### Glean and reference docs

The Assistant can search your organization's **Glean** (Slack, Drive, Confluence, Jira, GitHub, people and meetings, limited to what you can see) and read **reference documentation** folders, such as the `aggbrain` and `wallet-brain` doc repositories. Both are always available. It picks the docs by topic, and "check aggbrain" in a task or comment makes it start there ([D-38](docs/DECISIONS.md)).

- **Reference docs:** list folders of `.md` files as `name=/path` in `KNOWLEDGE_BASES` (`.env`), then run `scripts/bootstrap.sh` and `docker compose up -d ops-mcp`. They are mounted read-only. A folder with an agent skill (`.agents/skills/<name>/SKILL.md`, as Claude plugins have) tells the Assistant what it covers and how to read it.
- **Glean:** set `GLEAN_MCP_URL` in `.env` (Glean's MCP Configurator at app.glean.com/settings/connected-apps, "Custom" host, shows it: `https://<company>-be.glean.com/mcp/<server>`). Then `docker compose up -d glean-mcp` and press **Connect** in the banner on the board (`http://127.0.0.1:3120`). `glean-mcp` exposes only search and read tools. If Glean stops accepting the sign-in, the banner returns with **Reconnect**.

### GitHub issues and pull requests

The Assistant reads GitHub issues and pull requests, including private ones you can see, with their comments and reviews. Ask it to **post** and it comments on the issue as you: "post it" after a draft, or "post an update on the ticket". Ask it to **open a ticket** and it files a new issue as you, with labels, optionally on an organization project board in a column: "open this on the waas board (link), label `waas`, in Triage". It also **closes, labels and assigns** issues, **reviews** a PR with the verdict you give ("approve it"), and **re-runs failed CI** when you ask. All of it goes only to repositories and projects in `GITHUB_COMMENT_ORGS` (`.env`); it can't edit issue text or merge ([D-39, D-42, D-46](docs/DECISIONS.md)). Ask it to merge PRs and it hands that to an Engineer task (below).

- **Setup:** `scripts/bootstrap.sh`, then `scripts/github-auth.sh` (copies `gh auth token` into the secrets directory), then `docker compose up -d github-mcp`. Re-run `scripts/github-auth.sh` after `gh auth login`.

## Coding jobs

Comment on a task and the work happens in a repository on this machine, the way you'd run an agent in a terminal tab, but tracked in Paperclip.

1. **Assign the task to an Engineer.** The Engineer picks the engine: **Engineer · Codex**, **Engineer · Claude** (Claude Code) or **Engineer · OpenRouter** (GLM, DeepSeek, Kimi and other OpenRouter models through opencode). To pick the model and effort too, switch the assignee's **Model lane** to **Override**; the board suggests the models listed under the agent's `models` in `config/paperclip.yaml`, and any other OpenRouter id works when typed in full. Tasks you wrote start right away. Tasks Pennyworth created from Slack, email or meetings wait for your comment, because their text is other people's words.
2. **Talk to it like a colleague** ([design](docs/design/conversational-engineers.md)). Every comment goes to the Engineer with the whole task in context: every comment so far (yours, its own replies, the runner's messages, other agents' notes), the task it is part of, and the live state of its branches, PRs and merges. So "as I said", "them" and "the list" mean what you'd expect. Every repository you or the task mention joins the workspace; it clones others itself. There's no syntax to learn: ask for an answer, a look, a change, a different engine or model ("use Opus", "let Grace do it"), a fresh start or a clean-up, in your own words.
3. **The runner picks it up** within about 20 seconds. It gives the task a workspace, `~/pennyworth/tasks/<task>/`, with a full clone of each repository it needs (copied from the runner's cache in `~/pennyworth/repos`), and runs the engine there inside your devshells under Codex's sandbox (writes only in the workspace and build caches). The agent works the way you would in your own checkout (D-41): it puts each change on its own branch, named in the repository's style (its contributing guide, else your own recent branches there, else everyone's: `feat/…`, `<you>/…`), stacks a branch on another when one change builds on the next, and commits as it goes. It runs `pennyworth-repo org/name` to bring in another repository mid-run. Afterwards the runner moves commits made on a default branch to a branch of their own, signs the agent's commits with your key, and posts the Engineer's reply, with a table of the task's branches when they changed. The task goes to *in review*. A comment that needs no answer ("thanks") gets none.
4. **Follow-ups** continue the same session in the same workspace. If a PR was merged meanwhile, commits made on its branch since move to a fresh branch from the latest default branch.

While a run is going, a comment can't reach the Engineer until it finishes, so a short reading decides: "stop" (or "hold on, wrong repo") stops it, "how's it going?" gets an answer from what the run is doing, and anything else waits for the Engineer's next turn.

**Publishing and merging:** ask in your own words ("push it", "open the PRs", "then merge them in the order I listed"). The Engineer does it with its own tools, and the runner checks each push, PR, merge and Primer publish against what you wrote, with a call that reads only your comments and its last reply, never code, logs or documents. If your words don't cover it, the Engineer asks. The exact words still work as shortcuts, as a comment on its own:

| Command | What it does |
|---|---|
| `push` | publish every branch with new commits to GitHub (forced only to replace the task's own earlier version of a rebased branch, never over anyone else's commits: D-49), parents before the branches stacked on them. An empty repository gets the work as its first commit on `main` |
| `pr` | push, then open a **draft** PR for every branch that has none, each into its base (a stacked branch's PR goes into its parent's branch), with a title and description written for the repository's reviewers. Open PRs just get the new commits |

Repositories outside your orgs are read-only (D-35): their branches are listed but never published.

**Slack and Glean:** Ada and Grace read your Slack (DMs included) and search Glean, read-only, like Alfred does ([D-51](docs/DECISIONS.md)). A task that came from a Slack message points them at it, so they work from what was actually said, not the task's summary. Linus never gets either.

**Logs, metrics and infrastructure:** Ada (Claude Code) and Grace (Codex) read Grafana and Google Cloud, read-only, like you do locally with the Grafana MCP and `gcloud` ([D-48](docs/DECISIONS.md)). A question or investigation doesn't need a repository: "why did the bridge API 5xx at 3am?" runs straight against logs and metrics, and the agent clones the code it needs. Linus (OpenRouter) never gets them: those prompts go to third-party providers.

- **Grafana:** set `GRAFANA_URL` in `.env` (e.g. `https://polygonprod.grafana.net`), `docker compose up -d grafana-mcp board`, and press **Connect** in the Grafana banner on the board (`http://127.0.0.1:3120`). Pennyworth asks Grafana for read and query scopes only, so Grafana itself refuses any change; grafana-mcp also exposes only queries and reads.
- **Google Cloud:** run `scripts/gcloud-auth.sh` (a browser sign-in into Pennyworth's own gcloud directory; your `~/.config/gcloud` is untouched), and list your usual projects under `gcp.projects` in `config/runner.yaml`. Each job gets a one-hour token narrowed to per-API read-only scopes: logs, Monitoring, Compute, the GKE API (not kubectl), Cloud Run, Cloud DNS and Memorystore. Secret Manager, KMS, IAM, Cloud SQL, Storage and BigQuery are out of reach. Your Google Cloud session lasts 16 hours; when it runs out, jobs say so and you run the script again. Jobs can't read either gcloud sign-in.

**Merging PRs:** ask the Engineer to merge a list of PRs ("merge these one by one, at least 15 minutes apart, watch CI on master"); it queues them, and the runner merges them in code when its run ends ([D-46](docs/DECISIONS.md)). Before each merge, the PR must be approved with green checks, mergeable, and its base branch green. An approved draft is marked ready first. After each merge it waits for the base branch's CI and the gap, and comments as it goes. Anything red, unapproved, conflicting or stuck for 90 minutes stops the queue with a comment; "carry on" resumes, "stop" stops. Settings: `merges.gap_minutes` and `merges.timeout_minutes` in `config/runner.yaml`.

Agents can't push or write to GitHub themselves: `gh` is wrapped read-only, pushes are disabled in the runner's clones, and a pre-push hook and an ssh wrapper both refuse them. Only *your* comments are instructions.

Engine credentials live in `~/.config/pennyworth/` (0600): `openrouter_key` for OpenRouter, and `claude_oauth_token` from `claude setup-token` for Claude Code. Claude Code runs in a runner-owned home with no settings, plugins or connectors, no MCP servers but read-only Primer and Grafana, a fixed tool allowlist, and `codex sandbox` around the whole process.

## Slack

Pennyworth reads Slack through Slack's official MCP server (`mcp.slack.com`). That server has no dynamic client registration, so you need a public OAuth client registered for your workspace, with callback `http://localhost:3118/callback`. Set its ID as `SLACK_CLIENT_ID` in `.env`, then:

```sh
scripts/slack-auth.sh              # once: open the printed URL and approve
node scripts/paperclip-setup.mjs   # activates the Slack scan routine
```

The `slack-mcp` sidecar holds your user token, refreshes it (Slack rotates refresh tokens), and exposes read tools plus one write: saving a **draft** in your Drafts & Sent, in a channel, DM or thread, for you to edit and send from Slack ([D-46](docs/DECISIONS.md)). Only the Assistant can draft, and only when you ask ("draft a reply in that thread"). Send, schedule, react, canvas and list tools are never listed, and are refused if called. Consent asks only for read and search scopes, but Slack may grant the app's other scopes too, so the proxy's allowlist is what stops sending.

The Slack Scout creates two kinds of tasks, each with a permalink and a `source:slack:<channel>:<ts>` marker so nothing is duplicated:

- `needs-response`: someone is waiting for your reply. It closes once you answer in the thread. A request to review a GitHub PR closes once you've reviewed it, or it's merged or closed (the runner checks with read-only `gh`).
- `todo`: something you promised.

To hand Pennyworth a Slack message yourself, react to it with your task emoji (📌 `:pushpin:`, set in the Slack scan routine). It becomes a `todo` on the next scan, whoever wrote it and however old it is. Remove the reaction and the task closes. A task you close stays closed. Slack's own Later list can't be used: Slack has no API for it that tells open items from completed ones ([D-30](docs/DECISIONS.md)).

## Telegram

Optional. Pennyworth reads Telegram as you, through a session of your own account that can only read ([D-37](docs/DECISIONS.md)). To set it up:

1. Create an app at [my.telegram.org](https://my.telegram.org) (API development tools; any name), and save its credentials:

   ```sh
   printf '{"api_id": 1234567, "api_hash": "0123456789abcdef0123456789abcdef"}' > ~/.config/pennyworth/telegram/api.json
   chmod 600 ~/.config/pennyworth/telegram/api.json
   ```

2. Set `TELEGRAM_ME_ALIASES` in `.env` (words people call you, for mentions by plain name), then `docker compose up -d --build telegram-mcp board`.
3. Open the board on the computer (`http://127.0.0.1:3120`), click **Connect** in the Telegram banner, and enter your phone number, the code Telegram sends to your app, and your 2FA password if you have one.
4. `node scripts/paperclip-setup.mjs` activates the Telegram scan routine.

Pennyworth then sees your main chat list: DMs, groups and channels. Muted and archived chats are left out (`TELEGRAM_INCLUDE_MUTED`, `TELEGRAM_INCLUDE_ARCHIVED`), and so are chats you list in `TELEGRAM_EXCLUDE`. Channels can be read when you ask, but aren't scanned. New messages arrive live, and a sweep every 5 minutes catches up on anything missed. It finds mentions of you (Telegram's own flag, plus your aliases), replies to your messages, DMs and your own messages. The Telegram Scout decides which need a task, using the Slack Scout's rules, and closes a `needs-response` task once you've replied in the chat.

**What it can't do:** `telegram-mcp` refuses every Telegram request except a fixed list of reads, below all of its own code. It never sends, drafts, edits, reacts, joins, downloads files, changes your account, shows you as online, or marks anything read: your unread counts stay yours. Only cursors and message IDs are kept on disk.

**The session** shows as "Pennyworth" under Telegram → Settings → Devices; ending it there cuts Pennyworth off at once, and the board shows a banner with **Reconnect**. Signing in works only on the computer's own address, not from the phone.

## Primer

Optional. Primer is your organization's document host. The Assistant reads Primer links on your tasks (latest version and reviewers' comments), and publishes a draft as a new document or a new version when you ask on the task ("put this in Primer", "update the Primer doc"). It replies with the link. Set `PRIMER_MCP_URL` (the server's `/mcp` endpoint) in `.env`, then:

```sh
scripts/primer-auth.sh             # once: open the printed URL, sign in, approve
node scripts/paperclip-setup.mjs   # gives the Assistant the primer server
```

The `primer-mcp` sidecar holds the token pair (Primer rotates the refresh token on every use) and exposes only reads plus `primer_create_document` and `primer_add_version`. Deleting, sharing, changing visibility and page events are never listed ([D-31](docs/DECISIONS.md)). New documents are visible to your whole organization, as with any Primer document. Change that in Primer if you need to.

Engineer jobs read Primer too, every engine, through the same sidecar's read-only endpoint on `127.0.0.1:3123` ([D-40](docs/DECISIONS.md)). Ask an Engineer task for a Primer report ("publish it to Primer") and the runner publishes the agent's document after the run, then a new version each time a later run changes it ([D-44](docs/DECISIONS.md)); the jobs themselves still can't publish. Nothing to set up beyond the sign-in above; restart the runner after it.

## Google

Pennyworth uses its own read-only sidecar (`services/google-workspace-mcp`) rather than Paperclip's Google connector ([D-9](docs/DECISIONS.md)).

1. In a Google Cloud project under your Workspace account, enable the **Calendar**, **Drive**, **Docs** and **Gmail** APIs.
2. Configure the OAuth consent screen (*Internal* if your Workspace allows it) and create an OAuth client of type **Desktop app**. An *External* consent screen left in **Testing** gives refresh tokens that expire after 7 days, so publish it to **In production**.
3. Run `scripts/google-auth.sh <client json>` (or no argument, to paste the ID and secret) and approve in the browser. The only scopes are `calendar.events.readonly`, `drive.readonly` and `gmail.readonly`. The refresh token goes to `~/.config/pennyworth/google_oauth.json` (0600) and is mounted into the sidecar only.

**Several accounts:** `scripts/google-auth.sh --email you@work.com --primary` for the account whose Calendar and Meet transcripts Pennyworth should use, then `scripts/google-auth.sh --email you@other.com` for each extra account. Gmail and Drive cover every connected account.

**Expired sign-in:** when Google stops accepting an account's token, the board shows a red banner naming the account and what is paused. **Reconnect** takes you through Google's consent screen and back to the board, with no terminal needed. It works on the computer's own address (`http://127.0.0.1:3120`), not from the phone (D-36). `scripts/healthcheck.sh` checks every account as well.

If Workspace policy blocks consent, nothing else breaks: matching reports "calendar unavailable" and sources stay pending. Don't weaken Workspace settings to work around it, and check your organization's policy before connecting work accounts.

## Configuration

| File | Purpose | In git |
|---|---|---|
| `.env` | host paths, user IDs, vault folders, reference doc folders, board LAN settings, Slack client ID, Telegram aliases and excluded chats, Primer, Glean and Grafana endpoints, GitHub comment organizations | no (`.env.example`) |
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
- Engineer jobs read Grafana and Google Cloud with read-only OAuth scopes (Grafana and Google refuse writes themselves), and can't read either gcloud sign-in ([D-48](docs/DECISIONS.md)).
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
