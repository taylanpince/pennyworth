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

- **Decision:** review tasks are resolved by commenting on them:
  - `pick N` or `ignore` for meeting matches;
  - `route <path>` or `route none` for routing.
- **How it's applied:** ops-mcp parses only comments written by humans (`authorType: user`), at the start of every scan. Choices are stored, and routing choices go into `routing_memory` (by series ID, then by normalized title), so similar meetings route automatically.
- **Latency:** review tasks are unassigned, so a comment doesn't wake an agent. The decision is applied on the next scan: the next file event, or within 15 minutes during work hours. To apply it at once, use "Run now" on the Meeting scan routine.

## D-5: Matching additions

The weights and thresholds follow §15. Three rules were added, all configurable:

- **`review_min_temporal` (default 40):** a candidate with a strong time match is never silently "unmatched". It goes to review even when the total is below 55. Without this rule, the §42 scenario (a transcript at 15:01 with no other evidence) would be "unmatched" instead of "review".
- **`ambiguity_margin` (default 10):** if the runner-up is within 10 points of the top candidate (and at or above the review threshold), the result is review, even above 75. This implements "Multiple strong Calendar candidates → do not write" (§37).
- **Explicit attachment link:** a Drive document attached to exactly one calendar event is matched to that event. Google Meet attaches transcripts and Gemini notes to the event, so this is the strongest evidence available.

Also:

- Local whisper transcripts often have only a date in the filename. Their time evidence then comes from the file's mtime, which marks when the transcript finished, close to the meeting's end. This is scored against the event's end, capped at 45.
- Person names in filenames (`Kira-2026-09-21.txt`) count as "filename hints" when they match an attendee.
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
  - Browser use, computer use, image generation and web search.
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

The AI Tool Hub page lists Paperclip as "Security team only". The user cleared using it with the Security team lead, who runs Paperclip himself, before implementation started (2026-10-04).

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

- **Decision:** `services/slack-mcp` proxies `https://mcp.slack.com/mcp`, which is approved on go/mcps, with the user's token. It exposes an allowlist of read tools; anything matching send, post, schedule, update, create, delete, reaction, draft, upload or similar is never exposed, even if allowlisted.
- **Auth:** OAuth 2 with PKCE, using Polygon's public client (`SLACK_CLIENT_ID`) and its registered loopback callback on port 3118. Only read and search user scopes are requested.
- **Tokens:** Slack rotates refresh tokens, so the token file lives in `$PENNYWORTH_SECRETS_DIR/slack/` (0700), mounted read-write into the sidecar only.
- **Why not Codex's own MCP OAuth:** the login would have to run inside the container, where the browser callback can't reach. A proxy also lets us enforce read-only access in code, independent of the Slack app's configured scopes.
- **Polling:** the Slack Scout polls every 30 minutes during work hours, with no public ingress (spec §29, §25).
