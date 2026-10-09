# Design decisions and deviations from SPECS.md

Each entry records what was decided, why, and what it costs. The spec stays the source of intent; this file explains where the implementation differs and why.

## D-1: Obsidian through the filesystem, not the Local REST API (§19–§21)

- **Decision:** ops-mcp writes vault files directly. The REST plugin is not used.
- **Why:**
  - It's what the vault owner asked for.
  - It removes the container-to-host-loopback problem (§20) entirely.
- **How the spec's guarantees are kept:**
  - Only ops-mcp sees the vault. Paperclip has no vault mount.
  - ops-mcp sees only the folders listed in `VAULT_FOLDERS`, bind-mounted individually (`compose.vault.yaml`). Personal folders are invisible to it.
  - On top of that, the code checks `read_roots`/`write_roots`, rejects `..`, absolute and hidden paths, and resolves symlinks before every check.
  - New notes are created with `O_EXCL`, so an existing file is never overwritten.
  - Existing notes only receive insertions. Each write:
    1. reads the note and hashes it (the "version");
    2. computes the insertion;
    3. verifies that the result minus the insertion is byte-identical to the pre-image;
    4. writes a temp file in the same directory;
    5. re-hashes the note and aborts with a conflict if it changed;
    6. renames atomically.

    A conflict is retried once (re-read, recompute). The second failure creates a review task.
- **Cost:** a race window of microseconds remains between the final re-hash and the rename. Obsidian picks up external changes, and the vault is backed up by Obsidian Sync.

## D-2: Coarse, transactional ops-mcp tools

- **Decision:** the LLM never sequences writes. Code makes every decision that writes something durable:
  - `meeting_match` scores and decides;
  - `meeting_publish` validates the extraction, creates the canonical note, routes, checks markers, appends and creates tasks;
  - `meeting_resolve` records user choices.
- **Why:** this applies the spec's "deterministic state outside prompts" rule more strictly. It also shrinks the prompt-injection surface to "the model writes JSON that gets validated and escaped".
- **Consequence:** the low-level `obsidian_create_meeting_note` / `obsidian_append_meeting_entry` tools listed in §19 are internal functions, not MCP tools. Only read tools (`obsidian_search`, `obsidian_read`, `obsidian_read_document_map`) are exposed.

## D-3: ops-mcp creates Paperclip tasks (with deduplication)

- **Decision:** ops-mcp creates review and action tasks itself, through Paperclip's REST API, with the Meeting Librarian's agent key.
  - Every task has a marker (`<!-- source:… -->`).
  - Each task is recorded in SQLite (`external_tasks`) before and after creation.
  - Paperclip's `idempotencyKey` is set from the marker.
- **Why:** deterministic deduplication, independent of whether the model searches correctly.
- **Constraint found:** Paperclip lets agent keys *create* issues anywhere, but only lets them *update* other issues inside a heartbeat run.
  - ops-mcp therefore tries to close resolved review tasks itself.
  - When Paperclip refuses, it hands them to the agent through `tasks_to_close` in the scan result, and the agent closes them during its run.

## D-4: Manual review through comments

- **Decision:** meeting match review tasks are resolved by commenting `pick N` or `ignore` on them. (Routing review tasks, `route <path>` / `route none`, were removed in D-18.)
- **How it's applied:** ops-mcp parses only comments written by humans (`authorType: user`), at the start of every scan, and stores the choice. Routing choices made while routing tasks existed are still in `routing_memory` (by series ID, then by normalized title) and still route those meetings.
- **Phrasing:** parsing is lenient: "pick 2", "2", "option #2" and "ignore" all work.
- **Latency:** ops-mcp applies replies within about a minute, through a background sync, so you don't wait for a scan. Closing the review task in Paperclip happens on the next Meeting scan, because only an agent run may update it.
- **Assignment:** every task Pennyworth creates is assigned to the user (the company's default responsible user). Otherwise Paperclip hands an agent-created task to that agent, and a user comment would wake the agent instead of reaching ops-mcp. This is what happened on PEN-27.

## D-5: Matching additions

The weights and thresholds follow §15. Three rules were added, all configurable:

- **`review_min_temporal` (default 40):** a candidate with a strong time match is never silently "unmatched". It goes to review even when the total is below 55. Without this rule, the §42 scenario (a transcript at 15:01 with no other evidence) would be "unmatched" instead of "review".
- **`ambiguity_margin` (default 10):** if the runner-up is within 10 points of the top candidate (and at or above the review threshold), the result is review, even above 75. This implements "Multiple strong Calendar candidates → do not write" (§37).
- **Explicit attachment link:** a Drive document attached to exactly one calendar event is matched to that event. Google Meet attaches transcripts and Gemini notes to the event, so this is the strongest evidence available.

Also:

- Local whisper transcripts often have only a date in the filename. Their time evidence then comes from the file's mtime, which marks when the transcript finished, close to the meeting's end. This is scored against the event's end, capped at 45.
- Person names in filenames (`Kira-2026-09-21.txt`) count as "filename hints" when they match an attendee.
- Events the user declined stay candidates for Drive documents: Gemini notes are shared for meetings he declined, and their notes and actions still matter. Excluding them made those notes match unrelated blocks like "Family Time" and go to review (2026-10-06). Local transcripts are his own recordings, so declined events are still excluded for them.
- `transcripts.ignore_before` keeps the 36 existing transcripts from being backfilled on day one. Remove it to backfill.

## D-6: Networking: explicit 10.x subnets

- **Problem:** on this host, traffic to Docker's default `172.16.0.0/12` pools (except `docker0`) is dropped, most likely by the NordVPN firewall. Publishing `127.0.0.1:3100` from a compose network therefore failed.
- **Decision:** compose pins its networks to `10.231.0.0/24` (backplane) and `10.231.1.0/24` (egress). No host firewall change was needed.
- **Result:**
  - The backplane is `internal: true`.
  - ops-mcp is attached only to the backplane, so it has no route to the Internet (verified by `scripts/verify-security.sh`).
  - Paperclip and the Google sidecar also join `egress`.

## D-7: Codex sandbox inside the container

- **Facts:** Codex 0.159 sandboxes shell commands with bubblewrap, which needs unprivileged user namespaces. Docker's default seccomp profile blocks them in an unprivileged container (`cap_drop: ALL`, `no-new-privileges`).
- **Decision:** keep `--sandbox read-only` and do **not** loosen seccomp or add capabilities. Inside the container the sandbox fails closed: any shell command errors out. On top of that, the shell tools are disabled outright (`features.shell_tool=false`, `features.unified_exec=false`).
- **Also disabled:**
  - ChatGPT apps/connectors (`features.apps=false`): these could otherwise reach the ChatGPT account's own Gmail/Drive connectors.
  - Browser use, computer use, image generation and web search (later, cached web search for the Assistant only: D-19).
- **Result:** agents act only through vetted MCP tools.
- **Run workspaces:** Paperclip runs agents in non-git workspaces, so `codex_args` includes `--skip-git-repo-check`. Without it Codex exits before doing anything.
- **Also confirmed:** Paperclip's default for `codex_local` is `--dangerously-bypass-approvals-and-sandbox`. The setup script always sends `dangerouslyBypassApprovalsAndSandbox: false` and refuses `codex_args` without `--sandbox`.

## D-8: MCP servers go to Codex directly, not through Paperclip's tool gateway

- **Problem:**
  - Paperclip's Tool Gateway strips MCP tool annotations from `tools/list`.
  - Codex treats tools without annotations as needing approval, and in non-interactive runs (`approval_policy = never`) it rejects them.
  - So every ops-mcp write tool failed. This was verified with a real Codex run.
  - The gateway's server name (`native-<agent>-<digest>`) changes with every tool assignment, so it can't be configured.
- **Decision:** `scripts/paperclip-setup.mjs` writes the MCP servers into Paperclip's shared Codex config (`/paperclip/.codex/config.toml`), which Paperclip copies into every run's Codex home:
  - `ops_mcp`;
  - `google_workspace`;
  - `paperclip_tasks`: a tiny stdio bridge for task updates, because the shell has no network.

  Each entry has `default_tools_approval_mode = "approve"`. Bearer tokens come from env vars set from secret files at container start, and never appear in config.
- **Cost:**
  - Paperclip's per-tool policies and tool-call audit UI don't cover these servers. ops-mcp's own run log (`processing_runs`, structured logs with run IDs) is the audit trail.
  - Per-agent scoping is done with Codex config overrides in each agent's arguments. `mcp_servers.<name>.enabled=false` covers servers the agent isn't granted, and `mcp_servers.<name>.enabled_tools=[…]` narrows the tool list. Both come from `mcp_servers` / `enabled_tools` in `config/paperclip.yaml`. Paperclip's API shows these arguments as `***REDACTED***`, but they are stored and applied intact (verified in the database and in runs).
- **Revisit:** when Paperclip's gateway forwards annotations.

## D-9: Google access: own read-only sidecar, native connector optional

- **Situation:** Paperclip's native Google Workspace connectors proxy Google's Developer Preview MCP servers. They require Google to enroll both the consenting account and the GCP project, which takes days and can't be done overnight.
- **Decision:** `google-workspace-mcp` is a small sidecar that calls the normal Calendar and Drive REST APIs.
  - Its only scopes are `calendar.events.readonly` and `drive.readonly`.
  - It makes only GET requests.
  - The refresh token is stored in a secret file mounted into the sidecar only.
  - ops-mcp still holds no Google credentials (§9).
- **Fixture mode:** `GOOGLE_FIXTURES_DIR` serves calendar data from `fixtures/` (the spec's Phase 1 fixture adapter).

## D-10: Paperclip specifics

- **Image:** `ghcr.io/paperclipai/paperclip:2026.1001.0`, pinned by digest. The image installs agent CLIs with `@latest` at build time, so the digest pin is what keeps it stable.
- **Mode:** authenticated + private, bound to 0.0.0.0 inside the container and published only on `127.0.0.1:3100`. Sign-up can be disabled after you create your account (`PAPERCLIP_DISABLE_SIGN_UP=true`).
- **Task states:** Paperclip's statuses are fixed (`backlog, todo, in_progress, in_review, done, blocked, cancelled`). `WAITING_ON` is the `waiting-on` label (§26). Action items owned by someone else get `waiting-on`, and the user's own get `meeting-action`.
- **Routines:** "Meeting scan" has two triggers:
  - an HMAC-signed webhook, fired by the systemd path watcher;
  - a schedule every 15 minutes during work hours, which covers review decisions, Drive documents and missed events.

## D-11: Security approval

Pennyworth reads work email, Slack, calendars and documents. The user cleared running it on work data with their organization's security team before implementation started (2026-10-04). Anyone else running it on work accounts should do the same.

## D-12: Todo list = Paperclip tasks

- **Decision:** there is no separate todo store. Your todos are Paperclip tasks:
  - manual items get the `todo` label;
  - meeting actions get `meeting-action`;
  - priority is Paperclip's priority field.
- **Interfaces:**
  - `scripts/todo.mjs`, which acts as you through the board key;
  - the Paperclip UI;
  - the Chief of Staff's daily brief, which ranks items and suggests changes but never edits your tasks.
- **Supporting tool:** `task_create` in the paperclip-tasks bridge is idempotent by marker (Paperclip `idempotencyKey`), so re-running the brief updates "Daily Brief — <date>" instead of creating a second one.

## D-13: Slack through Slack's official MCP, behind a read-only proxy

- **Decision:** `services/slack-mcp` proxies `https://mcp.slack.com/mcp`, with the user's token. It exposes an allowlist of read tools; anything matching send, post, schedule, update, create, delete, reaction, draft, upload or similar is never exposed, even if allowlisted.
- **Auth:** OAuth 2 with PKCE, using a public client registered for the workspace (`SLACK_CLIENT_ID`) and its registered loopback callback on port 3118. Only read and search user scopes are requested.
- **Tokens:** Slack rotates refresh tokens, so the token file lives in `$PENNYWORTH_SECRETS_DIR/slack/` (0700), mounted read-write into the sidecar only.
- **Why not Codex's own MCP OAuth:** the login would have to run inside the container, where the browser callback can't reach. A proxy also lets us enforce read-only access in code, independent of the Slack app's configured scopes.
- **Polling:** the Slack Scout polls every 30 minutes during work hours, with no public ingress (spec §29, §25).

## D-14: Coding jobs run on the host, as the user, behind guardrails

- **Need:** investigations and implementations across `0xsequence`, `0xPolygon` and `agglayer` repos, using the user's own GitHub/gh, gcloud (16-hour sessions), Grafana MCP and Nix devshells.
- **Rejected alternatives:**
  - *A dedicated OS user* means duplicating and re-authenticating every credential.
  - *Running coding agents inside the Paperclip container* means no toolchains, and a shell next to Paperclip's secrets.
- **Decision:** `services/runner` is a systemd user service that polls Paperclip for the user's comments on tasks labelled `engineer`. It runs Codex (or Claude Code, or OpenCode via OpenRouter) in runner-owned clones and per-task worktrees, inside the user's devshells, and posts the results back.
- **Guardrails:**
  - Only human comments are instructions; task text is fenced as untrusted.
  - Orgs are allowlisted.
  - Codex's workspace-write sandbox applies, with network on. OpenCode and Claude Code run inside `codex sandbox`.
  - Claude Code runs from a runner-owned config dir with a `setup-token` token: none of the user's settings, hooks, plugins, MCP servers or claude.ai connectors, and only built-in coding tools.
  - `gh` is read-only through a wrapper.
  - Pushes are blocked: `pushurl` disabled, a pre-push hook, an ssh wrapper refusing `git-receive-pack`, and `SSH_AUTH_SOCK` removed from the agent's environment. The runner checks the remote after every run.
  - The runner, not the agent, commits.
  - Publishing (`push`/`pr`, draft PRs only) is a deterministic action the user triggers explicitly, which is spec Phase 5's human approval.
- **Residual risk:** the agent runs with the user's identity and can read the user's files, including credentials. A deliberate prompt injection could try to misuse that, so the trigger rule (only the user's own comments start or steer work) is the main control. Per-repo container isolation can be added later where needed.

## D-15: Assistant agent and reply processing

- **Assistant** is a Codex agent woken by assignment.
  - **Tools:** Slack (read), Google Docs, Drive and Calendar (read), notes (read) plus `meeting_note_correct`, and Paperclip tasks.
  - **Output:** deliverables are drafted as task comments. Option 1, chosen by the user: no Google Docs writes; the user pastes.
  - **Finishing:** the task is handed back with `task_handoff` (assign to the user, status `todo`), which avoids Paperclip's "disposition" errors for agent-set `blocked` / `in_review`.
- **Replies:** pennyworth-runner (board key, host) checks the user's open tasks once a minute for new comments by the user. After a 90-second quiet period it starts the "Process task replies" routine with the task identifiers. Review tasks (ops-mcp) and engineer tasks (runner) are excluded, and closed tasks are ignored.
- **`meeting_note_correct`:** a short, single-line find/replace limited to Pennyworth-written content for one meeting: its canonical note, and its own Meeting Log entry blocks (from the entry heading to the next heading). It uses versioned writes and also updates the stored extraction, so a later re-publish keeps the correction.
- **`docs_read`:** uses the Docs API with tabs (`drive.readonly` scope). If the Docs API isn't enabled in the Cloud project, it falls back to Drive's text export, which covers the first tab only.

## D-16: Gmail, read-only

- `google-workspace-mcp` adds `gmail_search` and `gmail_read_thread` under the `gmail.readonly` scope. Nothing can send, draft, label or delete mail.
- The **Inbox Agent** runs every 30 minutes during work hours. The user chooses what becomes a task by applying the Gmail label `pennyworth`:
  - every labelled thread becomes one task (labels `todo` and `email`), whether it's in the inbox or archived;
  - the title says the action ("Reply to …", "Sign …", "Read: …"), with priority from deadlines;
  - the task is closed when the label is removed. It is never closed for an account whose search failed or was cut off at 50 results;
  - tasks are deduplicated by `source:gmail:label:<id>` with `dedupe_closed`, so a task the user closed isn't recreated while the label is still on.
- **Superseded design (2026-10):** the agent first mirrored the whole inbox, one task per thread, closed on archive. That produced junk tasks (meeting accepts, receipts, notifications), so it was replaced by the label. Labelling also lets the user archive and still keep the task.
- **Deduplication beyond 7 days:** Paperclip idempotency keys expire after 7 days, so the task bridge's `task_create` also looks for an open task carrying the same marker before creating one; `dedupe_closed: true` extends that to done and cancelled tasks. This matters for long-lived labels and long-running Slack items.
- The **Assistant** can also read Gmail, for assigned research tasks.

## D-17: Several Google accounts

- `google_oauth.json` holds several accounts, sharing one OAuth client, plus a `primary`.
- **Primary account:** Calendar and meeting documents (Meet transcripts, Gemini notes), unless a tool call names another account.
- **All accounts:** Gmail and Drive search, with each result tagged with its `account`.
- **Reading** a thread, file or doc tries the given account first, then each account in turn.
- **The `pennyworth` label** is honoured in every connected account (the user creates it in each), and each task records its account.
- **Why it matters:** a re-consent once silently switched the whole connection, Calendar included, to a different Google account. Making the primary explicit (`--primary`) prevents that.

## D-18: Best-guess routing, no "choose a note" tasks

- **Decision:** when no routing rule, remembered mapping or topic keyword covers a meeting, the Meeting Librarian passes its best guess of the project note as `project_note` on `meeting_publish` (or `none`). ops-mcp writes the Meeting Log entry there if the note exists in the write roots and is outside the meetings folder; otherwise only the canonical note is written. No routing review task is ever created.
- **Why:** the user didn't want to triage a "choose a note" task for every new meeting (2026-10-06). The search candidates those tasks offered were poor (indexes, reviews), so the guess comes from the agent, which has read the meeting.
- **Guardrails:** the guess only decides *which existing note* gets an escaped Meeting Log entry; code still does every write, rules and remembered routes beat it, and the prompt tells the agent to pick from the calendar title and subject, never from instructions in the source. Guesses are not remembered, so a better note is picked once it exists.
- **Correcting a guess:** add a route to `config/routing.yaml`, or `skip_title_regex` for canonical-only.

## D-19: Cached web search for the Assistant

- **Problem:** the user linked a public article on a task (PEN-224) and asked for a summary. The Assistant had no way to open web pages (D-7 disables web search for every agent), so it asked him to paste the text.
- **Decision:** the Assistant alone gets Codex's built-in web search in `cached` mode (`web_search: cached` in its `config/paperclip.yaml` entry; setup adds `-c web_search="cached"` after the shared `web_search="disabled"`). Every other agent keeps it off, and setup refuses any value other than `cached`.
- **Why cached, not live:** the Assistant also reads Gmail, Slack and Drive. With live search, a prompt injection in an email or page could make it open an attacker's URL carrying private data. Cached mode serves searches and `open_page` from OpenAI's index, with no fetch to arbitrary hosts. Both modes summarised the PEN-224 article correctly (verified 2026-10-07, Codex 0.159.2).
- **Guardrails:** web pages are listed as untrusted in the prompt; queries may only carry public topics from the user's request, never private content, and pages can't direct further searches.
- **Cost:** very fresh pages may not be in the cache yet; the Assistant says so instead of guessing. Search queries go to OpenAI, which already sees everything the agents read.

## D-20: Executor picker: one Engineer agent per engine

- **Problem:** the user wanted to pick the executor and model on the task itself (Claude + Opus 5.5, Codex + Sol, GLM) instead of writing it in a comment.
- **Decision:** Engineer is split into three never-woken agents with matching adapter types: Engineer · Codex (`codex_local`), Engineer · Claude (`claude_local`) and Engineer · GLM (`opencode_local`, model `openrouter/…`). The assignee picks the engine. Paperclip's own per-task model override (`assigneeAdapterOverrides.adapterConfig`: `model`, plus `modelReasoningEffort` for Codex or `effort` for Claude) picks the model and effort; otherwise the agent's primary model is used, then `config/runner.yaml`. The runner reads these on every run (`pickedEngine`).
- **Why:** Paperclip already renders a model picker for these three adapter types, both on the task and in the new-task dialog, so no UI had to be built. The agents are `dispatch: runner` (`wakeOnDemand: false`, no MCP servers, `dangerouslySkipPermissions` / `dangerouslyBypassApprovalsAndSandbox` false), so Paperclip never executes them.
- **One source of truth:** a comment that switches engine or names a model moves the picker (`pickerFor`): new assignee, plus an override unless the model is that Engineer's primary model. A task with an engine remembered from before the picker is moved once in the same way. Otherwise the picker wins over the runner's remembered engine.
- **Limits:** Paperclip's Claude model list is static and lacks some models (Opus 5.5 at the time), so Engineer · Claude's primary model is set in `config/paperclip.yaml`, and the agent page's model field accepts any id. The opencode list comes from the container's `opencode models`, so it doesn't show OpenRouter models, and non-OpenRouter picks are ignored. opencode has no effort flag.

## D-21: Review requests close themselves from GitHub

- **Problem:** review requests arrive through Slack (Slack Scout `needs-response` tasks), and the user usually reviews the PR before seeing the task, then has to close it by hand.
- **Decision:** pennyworth-runner checks the user's open tasks every 5 minutes (`reviews` in `config/runner.yaml`). A task is a review request if its description has a `PR: <link>` line (Slack Scout adds one), or its title mentions a review and it links exactly one PR. It closes as `done` once the user has submitted a review (approve, request changes or comment) *after the ask*, or the PR was merged. It closes as `cancelled` if the PR was closed unmerged. The closing comment says what was seen.
- **The ask time** comes from the Slack source marker's timestamp, else from when the task was created, so an older review doesn't close a re-review request.
- **Why the runner and its `gh`:** it is the one Pennyworth component that already has GitHub access, and it runs on the host. The calls are fixed read-only GraphQL queries in code (`services/runner/src/reviews.mjs`); no agent and no source text decides anything, and nothing is written to GitHub. A separate fine-grained read-only token (for a future PR Scout) would need approval in each org.
- **Not covered:** review requests without a PR link (a doc, a proposal), PRs only mentioned in passing, and re-requests after new commits once the user has reviewed after the ask.

## D-22: Our own task board

- **Problem:** in Paperclip's UI every task sat under Todo. The user wanted to stack-rank tasks into Today / Tomorrow / Later, a nicer UI, everything doable without opening Paperclip, and later the phone.
- **Decision:** `services/board`, a small service (Node, TypeScript, React built with Vite) on 127.0.0.1:3120. Paperclip stays the only task store. The board keeps only what Paperclip lacks, bucket and rank, plus read markers, in `data/board/board.sqlite`. Columns: Triage (every new task lands at the top), Today, Tomorrow, Later and Backlog (Paperclip `backlog` tasks start there). A check every minute rolls Tomorrow into Today at local midnight, appended below Today's unfinished tasks (on workdays only since D-28).
- **Everything on the board:** title, description (the hidden source marker is kept on edit, deduplication depends on it), priority, status, labels, assignee (you, the Assistant or an Engineer, with the D-20 model and effort override), the thread with replies, done/cancel/reopen, the Daily Brief, and the last 48 hours of closed tasks.
- **Security:** the board key never reaches the browser; the server allows only the calls above, only on tasks assigned to the user, the Assistant or an Engineer. It answers only to the host names in `BOARD_ALLOWED_HOSTS` (DNS rebinding), and writes must be same-origin JSON carrying `x-pennyworth-board` (CSRF). Task text is untrusted: Markdown is sanitised with DOMPurify, images, forms and inline styles are dropped, and the CSP allows only the board's own scripts and styles with no remote images. Container: read-only root, no capabilities, internal network plus the published loopback port.
- **Paperclip limits:** it refuses concurrent issue-list requests from one client (429), so the board makes one open-tasks request and one recently-closed request and filters by assignee itself. List descriptions are truncated, so the brief is fetched in full.
- **Phone:** `tailscale serve` in front of the loopback port, with the tailnet host name added to `BOARD_ALLOWED_HOSTS`. The layout is already mobile-first (tabs per column, move menu on cards, full-screen task sheet).

## D-23: The board on the phone, at pennyworth.local

- **Problem:** the user wanted the board on the phone over the home Wi-Fi at a friendly name. The board acts as the user and had no login: on loopback that was fine, on Wi-Fi anyone on the network could have used it.
- **Decision:** a second listener in the same service (container port 3121, published as `BOARD_LAN_BIND:BOARD_LAN_PORT`, here `0.0.0.0:80`), off unless `BOARD_LAN_CLIENTS` is set. It serves only clients from those networks (the home subnet; Docker keeps client addresses for published ports), only under `BOARD_LAN_HOSTS`, and its API only for **paired devices**. The loopback listener (3120) stays as it was.
- **Pairing:** the laptop's board (**Phone**) makes a one-time code, shown as `XXXX-XXXX` and as a QR link (8 characters without look-alikes, about 40 bits, 10 minutes, only its hash stored). The phone types it at pennyworth.local or opens the link, which only fills it in: pairing waits for a tap, because QR scanners open links in an in-app browser that would otherwise spend the code where the cookie is useless. The phone spends it for a session cookie (256-bit, stored hashed, `HttpOnly; SameSite=Strict`, a year). Pairing links and the device list are laptop-only, and devices can be removed there. Ten failed pairings in ten minutes lock pairing, which keeps guessing a 40-bit code hopeless.
- **Name:** `pennyworth.local` is published over mDNS by a NixOS system service (`nix/board-mdns.nix`, vendored into `~/config/nixos`) only while on the home Wi-Fi (`ssid`), following DHCP changes. It needs `services.avahi.publish.userServices = true`: with the NixOS default, avahi refuses D-Bus publishing from everyone, root included (found when the first switch published nothing). Any local program may now publish mDNS names, acceptable on a single-user laptop. The service runs as a throwaway user (`DynamicUser`) with no capabilities, a read-only system and no home access, and its script lives in the Nix store, not in a user-writable file.
- **Known limits:** plain HTTP, so the session cookie is only as private as the Wi-Fi. On an untrusted network someone could spoof `pennyworth.local` and capture it from a phone that tries to open the board there; remove the device if that's a worry. Tailscale (HTTPS, `100.64.0.0/10` in `BOARD_LAN_CLIENTS`) is the way to use it away from home.

## D-24: Engineer sub-tasks with one go-ahead on the parent

- **Problem:** some requests span many repositories (PEN-357: deprecation notices in 20 legacy repos). The runner works in one repository per task, and building multi-repo jobs wasn't worth it for something this rare.
- **Decision:** the user asks the Assistant, in a comment on their task (the parent), to split the work. The Assistant creates one Engineer task per repository with `task_create_engineer_task`, as a sub-task of the parent, assigned to the Engineer and model the user named (D-20). Each description is self-contained. The Assistant comments a list on the parent and leaves out publishing and GitHub-side steps (pushes, PRs, archiving, repo settings, closing issues, npm). If asked, it posts manual steps as a checklist comment.
- **The go-ahead:** sub-tasks wait, without a "Ready" greeting, until the user approves them. The runner reads the user's comments on a parent that has waiting sub-tasks before the Assistant gets them. A clear go-ahead ("go", "looks good, start them") starts all of them, queued at `max_concurrent`. "Wait" keeps them waiting. Anything else, including a go-ahead with changes ("go, but skip X"), goes to the Assistant. A comment on a sub-task itself also approves that one. Publishing still takes the exact word: **pr** on a sub-task opens its PR, and **pr** on the parent opens the PRs of every approved sub-task that has commits, one after another, then posts the links on the parent. When the last sub-task finishes, the runner posts a summary table on the parent, so the parent doesn't go quiet after "Starting N tasks" (PEN-357).
- **Why a go-ahead:** the Assistant also reads Slack and email, so a description it writes could carry someone else's words. Without a go-ahead, they would run as code changes on the user's machine unseen. One reply on the parent puts the user's look in one place instead of twenty.
- **Guards:** only the Assistant has the tool (`enabled_tools`; the Chief of Staff now has an explicit list too), and the bridge checks the caller's setup key. The parent must be one of the user's tasks. Sub-tasks are deduplicated per parent and repository, at most 40 per parent. The go-ahead reading has regression cases in `config/intake-cases.yaml`.

## D-25: Scheduled moves and recurring tasks

- **Problem:** the user wanted to leave a note on a task ("bring this to the top of my Today next Tuesday") and have it happen. Some of their work also repeats: a weekly team update drafted from Slack channels, GitHub activity and meeting notes, or monthly reviews. The draft should be ready in Today on the day, for the user to finish.
- **Scheduled moves:** the board stores one move per task (date, column, top or bottom) in its SQLite. The same once-a-minute check that rolls Tomorrow into Today applies due moves after the rollover, so they land on top, and catches up after downtime. Moving the task by hand, or dragging it to another column, cancels the schedule. Reordering within its column doesn't. Ways in: **Bring back** in the task sheet, or a comment the Assistant turns into a date (`task_schedule`).
- **Recurring tasks:** a recurring task is an ordinary task the user owns. Its description is the instructions for each run. The board stores the rule, the next run, a pause flag and the GitHub repositories to collect. Such tasks leave the columns for the **Recurring** panel and get the `recurring` label, so the Chief of Staff leaves them out of the brief and the review closer skips them. Ways in: **Repeats** in the task sheet, or a comment the Assistant turns into a rule (`task_recurring`), replying with the next three runs.
- **The rule is code, not cron:** weekly or every N weeks on a weekday, monthly or every N months on a day (clamped to short months, or the last day), or on the nth or last weekday. Runs are at a local time, 07:00 by default, in the user's timezone, DST included (`services/board/src/recurrence.ts`). Cron can't say "first Monday" (day-of-month and weekday are OR'ed) and doesn't catch up after the laptop slept.
- **A run:** every minute the runner claims due runs from the board's internal API.
  - The board creates the user's task for the period ("<title> — Mon, Oct 12, 2026", marker `recurring:<definition>:<local date and time>`) and puts it on top of Today. It then moves the rule on and records the window: from the previous run, or the previous occurrence, to this one.
  - The runner comments the period's GitHub activity for the listed repositories on that task: merged and opened PRs, releases, and issues opened or closed. These are fixed read-only GraphQL queries with the user's `gh`, as in D-21. Then it starts the **Run recurring task** routine.
  - The Assistant reads the definition, the GitHub comment, the previous period's task with the user's feedback on it, and the period's Slack channels, notes and documents. It writes the result into the task's description, ready to paste, and adds a comment with sources, gaps and what changed. It never posts anything.
  - A run that is claimed but not started is handed out again after 10 minutes, up to 3 times. After that the task says it failed, so a missed week never goes silent.
  - **Run now** runs an extra period, from the last run to now. Closing the definition stops it. A pause drops the missed periods: the next window is one period again.
- **Why the board owns schedules:** placement already lives there (D-22), and so does the user's view of what repeats. Paperclip routines with cron triggers would need a routine per task, can't express the rules above, and wouldn't put the result in Today.
- **Internal API:** a third board listener (port 3122) serves only `/internal/` routes, behind a bearer token (`board_internal_token`) compared in constant time and the host names `board:3122` and loopback. The tasks bridge reaches it from Paperclip on the internal network, and the runner on the host through the loopback port. Its writes go through the same checks as the board UI: the task must be one the board shows, a recurring task must be the user's own, and dates must be today or later, at most a year ahead.
- **Security:** only the Assistant has `task_schedule` and `task_recurring` (`enabled_tools`), and the bridge checks the caller's setup key. The prompt allows them only on the user's own comment. Runs use only the Assistant's read-only tools, and their output is a draft for the user, so no per-run approval is needed (the user chose this). Code work in a run would still go through Engineer sub-tasks and the go-ahead (D-24). GitHub titles in the activity comment are stripped of links, HTML and comments.

## D-26: Recordings match by their span, and Pennyworth tidies the files

- **Problem:** every local recording became a "Resolve meeting match" task, though the top candidate was right each time. The recorder names files by start time (`2026-10-08_11-01-59.txt`), and 1:1 titles ("Taylan / Monir") share nothing with the transcript, whose speakers are `[Me]` and `[Them]`. Time alone scores at most 50, below the 75 needed to match. Back-to-back 1:1s also look alike by start time alone: a recording started 14 minutes late is about as close to the next meeting's start. The user also used to rename transcripts and delete their audio by hand (`rename-transcript.sh`), which stopped once Pennyworth took over.
- **Matching:** the audio next to a transcript says when the recording ended: the WAV header's byte rate and the file size give its length (the header's data size is not trusted, since a recorder that dies leaves it unfinalized), else the audio's mtime. The transcript's own mtime is when transcription finished, up to 20 minutes later, so it can't be used. With start and end known, the event that covers at least 60% of the recording is the meeting, unless another eligible event covers 30% or more (double-booked, or the recording ran on into the next meeting). Those still go to review. On the six recordings so far (2026-10-07/08), this rule picked the user's own choice each time. Without audio, the old scoring applies.
- **Files:** once a meeting is matched and published, ops-mcp renames a recorder-named transcript the way the script did: `<Title>-<date>.txt`, the user's name, "1:1" and "(weekly)" dropped from the calendar title, and 1:1s (one other attendee) in `1-1s/`. It never overwrites: a name that's taken gets the recording time (`_15-13-58`), and files the user named are left alone. After the meeting note is written, the audio is deleted. Renames happen before the note is written, so the note lists the final name. Recordings published before this change, or whose rename failed, are finished on a later scan, and their note is refreshed.
- **Moves:** the scanner treats a known transcript that appears at a new path (same content, old path gone) as moved, not as new, so renames by ops-mcp or by hand never cause reprocessing.
- **Security:** the transcripts mount is now writable for ops-mcp, which still has no network egress; Paperclip and the agents still can't see it. Only ops-mcp code renames or deletes, inside the transcript root, never through symlinks, and only the audio file that shares the published transcript's original name. No agent tool can name a file to move or delete.
- **Tags:** canonical meeting notes carry `tags: [type/meeting]`, matching the vault's `type/…` tags, so `tag:#type/meeting` lists them all. Notes written earlier were tagged once. Notes that already had a `tags` key were left as they were.

## D-27: Telegram mentions through the organization's Telegram MCP, scanned in code

- **Problem:** the user's client and partner conversations happen in Telegram groups, and asks there ("@handle can we get them a temp API key?", "Dana or Lee will get you access") went unseen. The user's organization runs a per-employee Telegram MCP (`TELEGRAM_MCP_URL`): company sign-in, the employee's own Telegram session, an explicit chat allowlist chosen in a browser picker, read and native-draft tools, and no send tool.
- **Decision:** `services/telegram-mcp` is a read-only proxy in front of it, like D-13 for Slack. It exposes `list_allowed_chats`, `read_chat_history`, `search_chat_history` and `get_new_messages`. `create_reply_draft`, `get_pending_drafts` and `request_allowed_chats_change` are never listed: drafts land in the user's real Telegram, and the allowlist is the user's to change. A Telegram Scout agent turns candidates into `needs-response` and `todo` tasks with the Slack Scout's rules, and closes them once the user has replied.
- **Auth:** the server supports dynamic client registration, so `scripts/telegram-auth.sh` registers Pennyworth as a public client with a loopback callback (port 3119) and runs the code flow with PKCE. The token pair and its client ID live in `$PENNYWORTH_SECRETS_DIR/telegram/`, mounted read-write into the proxy only. The claude.ai connector can't be used: the agents are Codex inside Paperclip.
- **Candidates in code:** messages carry only a display name (no sender or account IDs) and mentions are plain text, so the proxy decides what may need the user. That covers mentions by `@handle` or by name as a whole word (`TELEGRAM_ME_HANDLES`, `TELEGRAM_ME_ALIASES`), replies to the user's messages (known by display name, `TELEGRAM_ME_NAMES`), DMs, and the user's own messages, for commitments. The agent only judges.
- **Background scan:** each upstream call takes 5 to 30 seconds, so a scan of every chat can't run inside an agent's tool call. The proxy scans every 15 minutes from a per-chat cursor, and reads context only for chats with new messages: one window per chat, not a read per message. `telegram_mentions` returns the prepared candidates at once. A candidate comes back until `telegram_mentions_ack`, at most 3 times.
- **What's stored:** `scout.json` keeps cursors and message IDs only. Message text stays in memory and is re-read after a restart, in line with the upstream server's own rule of never persisting content.
- **Chat identity:** `chat_ref`s are opaque and change whenever the user edits the allowlist. Task markers use them (`source:telegram:<chat_ref>:<message_id>`), and `telegram_followups` falls back to the chat title, which the description's `Chat:` line carries. Message IDs are not contiguous: small groups and DMs share the account's counter. Context is therefore read as "the messages before", never as an ID range.
- **Coverage:** only the chats on the allowlist are seen. A new client group means adding it in the server's chat picker.
- **Security:** only the Telegram Scout has the `telegram` server. It has no send or draft tool, and its prompt forbids copying credentials (people paste API keys in these chats) into tasks. The proxy has no published ports and mounts only its own directory.

## D-28: Tomorrow means the next workday, and leftovers are marked

- **Problem:** the rollover appended Tomorrow below whatever was left in Today, so a day with leftovers became one big pile to sort through, with nothing telling the leftovers apart from the plan. It also ran every midnight: on a Friday, "Tomorrow" landed in Today on Saturday.
- **Workdays:** the rollover only runs on `workdays` in `config/system.yaml` (Monday to Friday by default). A day off keeps the last rollover date, so the next workday rolls over once. The Tomorrow column says "Rolls into Today on Monday" when the next workday isn't the next day. Scheduled moves and recurring runs keep the exact dates they were given.
- **Carried over:** each placement counts the rollovers it has stayed in Today through (`carried`). Reordering within Today keeps the count; any move to another column, a move by hand, a scheduled move or arriving from Tomorrow resets it. Cards show "Carried Nd", and a bar on top of Today handles all of them at once: **Keep** (they count as planned from now on), **→ Tomorrow** or **→ Later** (to the top, in order, cancelling their schedules).
- **Order:** leftovers stay on top of Today, above the new plan (the user's choice). Nothing moves on its own: the board never drops old leftovers to Later by itself.
