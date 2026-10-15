# Design: a direct Telegram connection (replaces D-27's upstream)

Status: accepted, 2026-10-15 (decisions at the end). Once built, this becomes **D-37** in `docs/DECISIONS.md`. It replaces the upstream half of D-27 and the Telegram part of D-33. The Scout's rules, task markers and the Assistant's read access (D-29) stay the same.

## Why

`services/telegram-mcp` proxies the organization's Telegram MCP. Most of D-27's machinery works around that server, not around Telegram:

| Problem today | Cause | With a direct session |
|---|---|---|
| A scan takes about 15 s per chat, calls queue, and more chats break it (timeouts on 2026-10-13/14) | Every read is a remote MCP call to a slow server | Reads take 100–300 ms; new messages arrive as live updates |
| Mentions are guessed from names in the text (`TELEGRAM_ME_NAMES`, `ALIASES`) | Messages carry only a display name | Telegram flags each message that mentions or replies to the user (`mentioned`), and gives real sender IDs |
| `chat_ref`s change when the allowlist changes; follow-ups fall back to titles | Opaque refs from the server | Chat IDs are Telegram's own peer IDs and never change |
| Only allowlisted chats are seen; adding a client group means using the picker | Server-side allowlist | Every DM and group by default, with a local exclude list |
| A 15-minute polling scan | No push from the server | Live updates, plus a one-call reconciliation every 5 minutes |

Approval: the user cleared a personal Telegram session with Chris on 2026-10-15, on the condition that the integration stays tight. The Security section below is that condition made concrete.

## Shape

```text
telegram-mcp (same container name, port 8083, same MCP tools)
├── session.ts   GramJS client from a StringSession (read-only compose secret)
├── guard.ts     wraps client.invoke: only allowlisted TL requests ever reach Telegram
├── reader.ts    the few reads we need (dialogs, history, by-ID, search) → our Message shape
├── scout.ts     event-driven candidate finder (rewritten), cursors in /state/scout.json
├── local-tools.ts  telegram_mentions / _ack / _followups (unchanged API)
├── tools.ts     list_allowed_chats / read_chat_history / search_chat_history / get_new_messages,
│                now served locally (same names and arguments, so prompts barely change)
├── login.ts     sign-in from the board (separate client, separate allowlist)
└── main.ts      MCP server, /healthz, and the board's /auth/* endpoints
```

**Library: GramJS (`telegram` on npm, 2.26.x).** It's TypeScript, so it fits the other services (zod, pino, vitest), and it keeps nothing on disk beyond the session we give it. The alternatives:
- **TDLib** (`tdl`): needs a native binary, and keeps a local database with message content, which breaks the "no content on disk" rule from D-27.
- **Telethon:** Python, a second stack for one service.

The risk with GramJS is that it has a small team of maintainers. We pin the version and depend only on `invoke` and the TL classes, never on its high-level helpers' quirks, so swapping later would mean changing only `reader.ts` and `session.ts`.

## Security (the "tight" part)

The session string grants full control of the account. Its scope can't be narrowed, so every limit lives in code, and each limit is independently testable.

1. **Request allowlist at the lowest layer.** `guard.ts` replaces `client.invoke` with a check on `request.className` against a fixed list. Anything else throws `RefusedRequest` and is logged (the class name only). It sits below every GramJS helper, so a bug, a new tool or a library update can't reach a write.
   - **Allowed:**
     - `users.GetUsers` (getMe, senders)
     - `messages.GetDialogs`, `messages.GetPeerDialogs`
     - `messages.GetHistory`
     - `messages.GetMessages`, `channels.GetMessages`
     - `messages.Search`, `messages.SearchGlobal`
     - `messages.GetChats`, `channels.GetChannels`
     - the forum topics list
     - `updates.GetState`, `updates.GetDifference`, `updates.GetChannelDifference`
     - connection setup: `InvokeWithLayer`, `InitConnection`, `help.GetConfig`
   - **Never allowed (examples; the list above is exhaustive):**
     - Anything that sends, forwards, edits or deletes, saves drafts, reacts, joins or leaves.
     - `contacts.*`, `account.*`, `auth.*`, `payments.*`.
     - `upload.GetFile`: no media downloads in v1. Attachments are where malware lives, and we don't need them.
     - `messages.ReadHistory`, `channels.ReadHistory`, `messages.ReadMentions`, `messages.ReadReactions`. **Reading must never mark anything read:** the user's unread badges and mention counters stay theirs.
     - `account.UpdateStatus`: Pennyworth never makes the user appear online.
   - Signing in uses a **separate client** (`login.ts`) with its own allowlist: `auth.SendCode`, `auth.SignIn`, `account.GetPassword`, `auth.CheckPassword`, `users.GetUsers`, plus connection setup. It exists only for the minutes of a sign-in from the board (see 7), and the reading client never gets `auth.*`.
2. **No raw API surface.** MCP tools are fixed functions with zod-validated arguments: a chat ref, message IDs, a query and limits. No tool takes a method name, a TL object or a free-form peer string that would trigger a username lookup (`contacts.ResolveUsername` isn't allowed anyway).
3. **Credentials.**
   - `api_id`/`api_hash` (the user's own, from my.telegram.org) are `$PENNYWORTH_SECRETS_DIR/telegram_api.json` (0600), a **read-only compose secret** in telegram-mcp only.
   - The session string is `$PENNYWORTH_SECRETS_DIR/telegram/session` (0600). The `telegram/` directory stays the service's only writable mount (session plus `scout.json`), because a sign-in from the board writes the session. This is the same trade as `google_oauth.json` in D-36.
   - A sign-in that comes back as a different Telegram account than the one on file is refused. Starting over with another account means deleting the session file by hand.
   - The old OAuth `token.json` is deleted at cutover.
   - No extra encryption at rest: the key would sit on the same disk. The meaningful layer is the host's disk encryption plus the 0700/0600 permissions, the same as every other secret here.
4. **Visible and revocable.** The session logs in as device "Pennyworth (bloomware)", app "Pennyworth 1.0", so it shows clearly under Telegram → Settings → Devices, where one tap ends it. Telegram also sends its usual "new login" message to the account at login.
5. **Content stays untrusted and off disk.**
   - Message text is wrapped in `<untrusted-telegram-content>` tags by our code, which the upstream server used to do.
   - `scout.json` keeps only peer IDs, message IDs and cursors.
   - Message text lives in memory only.
   - pino never logs message text, and redacts `session`, `api_hash` and `authorization`.
6. **Unchanged:**
   - No published ports; read-only root filesystem; `dns` pinned; container user 1000:100.
   - Only the Telegram Scout gets the scout tools; the Assistant gets the four read tools (D-29).
   - The prompts' rules against copying credentials stay.
7. **Sign-in and session ended: a board banner, like D-36.**
   - telegram-mcp tracks its state: `missing` (never signed in), `ok`, `ended` (Telegram answered `AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED` or similar), or `error` (network trouble that may pass).
   - The board shows a red banner for `missing` and `ended`: what is paused, and **Connect** or **Reconnect**. Telegram signs in with a code and an optional 2FA password, not a redirect, so the button opens a small form: phone number, then the code Telegram sends to the user's app, then the 2FA password if the account has one.
   - Like Google's Reconnect, the form works only in local mode on `127.0.0.1:3120`/`localhost:3120`. Elsewhere the banner says to reconnect from the computer.
   - The board gets its own `telegram_auth_token`. It can read the sign-in state and drive a sign-in (`/auth/status`, `/auth/start`, `/auth/code`, `/auth/password`), never the MCP tools. The board never sees the session string.
   - A pending sign-in lives in telegram-mcp's memory for at most 10 minutes. The phone number, code and password are never logged or stored. On success, the session is written atomically (0600) and the reading client restarts with it.
   - `/healthz` reports the state too, `scripts/healthcheck.sh` checks it, and Scout tools return `telegram_auth_unavailable`, which the Scout already reports.
8. **Verification.** `scripts/verify-security.sh` gains checks that:
   - the guard is wired in;
   - the reading allowlist contains no send, read-marking, account or auth method (a static check of `guard.ts` against a `NEVER` pattern, like `policy.ts` today);
   - telegram-mcp mounts only `telegram/` and its secrets.

## Which chats

The user's main chat list, without archived or muted chats (the user's choice: archiving or muting a chat means "not this one"), filtered by type:

| Type | Scanned for candidates | Readable by the Assistant |
|---|---|---|
| DMs with people | yes | yes |
| Basic groups, supergroups (including forum topics and channel discussion groups) | yes | yes |
| Broadcast channels | no (nobody can mention you there) | yes |
| Bots, Saved Messages, service messages | no | no |

`config/telegram.yaml` (personal, gitignored; `config/telegram.example.yaml` in git):

```yaml
exclude: []          # chat IDs or exact titles never scanned or read (e.g. family chats)
include_muted: false
include_archived: false
```

Archived and muted chats are out of scope for every tool, like excluded ones. Broadcast channels are the only chats tools can read but the scan skips. A chat that is unmuted or unarchived comes into scope at the next sweep, starting at its current top message.

`list_allowed_chats` returns the chats in scope (name kept for prompt compatibility). Excluded chats are invisible to every tool, not just the scan.

## Identity and classification

- **The user** is `getMe()`: user ID and username. `TELEGRAM_ME_NAMES` and `TELEGRAM_ME_HANDLES` go away. `TELEGRAM_ME_ALIASES` stays for plain-text names ("taylan, can you…"), which Telegram doesn't flag.
- **Chat ref:** `tg:<marked peer id>` (users positive, basic groups `-id`, channels/supergroups `-100id`). It's stable for the life of the chat. A basic group that upgrades to a supergroup gets a new ID; the reader follows `migrated_to`, and follow-ups still fall back to the title.
- **Kinds** (the `Kind` values are unchanged, so the Scout prompt still applies):
  - `own`: `sender_id === me.id`.
  - `dm`: a DM with a person who isn't a bot.
  - `mention`: Telegram's `mentioned` flag (covers `@username` and name-link mentions), or an alias match.
  - `reply`: `reply_to.reply_to_msg_id` points to a message whose sender is the user. Known from the `mine` set, or one `GetMessages` call by ID (cheap now, so the `MAX_LOOKUPS` budget goes away).
  - Telegram also sets `mentioned` on replies to the user. The classifier separates `reply` from `mention` by checking the replied-to message, so the Scout still sees which it was.
- **Messages** gain `sender_id`, `username`, `from_user` (exact now) and `topic` (forum topic title, when there is one). `display_name` becomes the sender's first and last name. Telegram's "Name | Company" profile names still come through as they are.
- **Edits:** v1 ignores edits. A message edited to add a mention isn't caught until a later version handles `UpdateEditMessage` for messages within the last hour.

## Scanning: events plus a cheap reconciliation

1. **Start-up:**
   - connect, `getMe`, then `GetDialogs` for all folders (a few pages; each dialog carries `top_message`, `unread_count` and `unread_mentions_count`);
   - for each in-scope chat whose `top_message` is above its cursor, read `GetHistory` with `min_id = cursor` (paged at 100);
   - a chat never seen before starts at its `top_message`. Brand-new installs look back `TELEGRAM_LOOKBACK_HOURS` (default 24), but see Cutover.
2. **Live:** a `NewMessage` handler classifies each in-scope message as it arrives, adds candidates, and advances that chat's cursor. It saves state at most every 10 seconds.
3. **Reconciliation every 5 minutes:**
   - one `GetDialogs` sweep compares each chat's `top_message` with its cursor and fills gaps with `GetHistory`;
   - this covers updates GramJS dropped across reconnects, and process restarts, without trusting its update-gap handling;
   - it costs a few requests per sweep, against N slow calls per chat today.
4. **Context on demand:**
   - `telegram_mentions` builds each candidate's view when it's asked for: 5 messages before, the replied-to message, and up to 30 after.
   - At 100–300 ms per read, 30 candidates take a few seconds, and the view is always current (the "after" already includes the user's reply).
   - The pre-computed `views` map, `waiting_for_context`, `prepare()` and the 240-second first-scan wait all go away.
5. **Rate limits:**
   - GramJS's `floodSleepThreshold` is set to 60 s: a `FLOOD_WAIT` of up to 60 s is slept through, and a longer one fails the call with a clear error.
   - Context reads run sequentially per chat, at most 4 chats at a time.
   - Back-of-envelope: a busy day of about 1,000 messages across all chats needs about 300 reads (sweeps plus context), far below what an ordinary client uses.

`scout.json` keeps the shape it has today, keyed by the new chat refs: `chats[ref] = { cursor, mine[] }` (`floor` goes away now that lookups are cheap), plus `pending[]` and `handed_out`. The ack and handout rules (at most 3) stay.

## MCP tools

The names, arguments and result shapes stay the same, so `config/paperclip.yaml` `enabled_tools` and both prompts keep working. The only changes are additive fields and stable refs.

| Tool | Backed by | Notes |
|---|---|---|
| `list_allowed_chats` | in-memory dialog list (refreshed by the sweep) | `chat_ref`, `title`, `type`, `topic_titles?`, `unread_mentions` |
| `read_chat_history` | `GetHistory` (`offset_id`/`add_offset` for "before") | newest first, up to 50 (as today) |
| `get_new_messages` | `GetHistory` with `min_id` | oldest first, up to 100 (as today) |
| `search_chat_history` | `messages.Search`; without `chat_ref`, `SearchGlobal` filtered to scope | Global search is new: "what did Sam say about the RPC endpoint" no longer needs the chat |
| `telegram_mentions` / `_ack` / `_followups` | scout | `followups` looks up by ref, then by title as today |

## What changes elsewhere

- **compose.yaml:** the telegram-mcp block adds the `telegram_api` and `telegram_auth_token` secrets (the board gets `telegram_auth_token` too), keeps `telegram/` as its one writable mount, and drops `TELEGRAM_MCP_URL`, `NAMES` and `HANDLES`. The HEALTHCHECK port in the Dockerfile is fixed (it says 8082, a copy from slack-mcp).
- **Removed:** `tokens.ts`, `auth.ts`, the upstream client in `main.ts`, `policy.ts` (replaced by `guard.ts` plus the fixed tool list), `scripts/telegram-auth.sh`, `scripts/telegram-chats.mjs`.
- **Added:** the board's Telegram banner and sign-in form (`services/board/src/telegram.ts`, `TelegramBanner`), mirroring D-36. `scripts/bootstrap.sh` generates `telegram_auth_token`. The first sign-in uses the same form ("Connect"), so no login script is needed.
- **Prompts:**
  - `telegram-scout.md`: "allowed chats" becomes "your chats". The note about the `Chat:` line becomes "finds the chat again if it is renamed". It mentions the `topic` field.
  - `assistant.md`: drops the "access denied / refs change" paragraph, and adds global search.
  - Routine cadence is unchanged (every 30 minutes in work hours). Candidates are now ready within seconds, so the cadence can tighten later without touching code.
- **Docs:**
  - README's Telegram section is rewritten.
  - AGENTS.md: the Telegram gotchas (slow upstream, changing refs) become the new ones: the request guard, never mark read, the session is the whole account.
  - D-37 is added; D-27 and D-33 get "superseded in part by D-37".
  - `.env.example` and `config/telegram.example.yaml`.
- **healthcheck:** the session is valid, `getMe` works, and the last sweep is under 10 minutes old.

## Cutover

1. The user creates an app at my.telegram.org and saves `telegram_api.json`. Build, then sign in from the board.
2. **No backfill on the first start** (`TELEGRAM_LOOKBACK_HOURS=0` for that start): every cursor starts at the current top message.
   - New refs mean new markers, so a backfill could recreate tasks for messages the old scout already handled.
   - Anything that arrived before the switch was already scanned by the old proxy.
3. Open Telegram tasks keep their old `source:telegram:<old ref>:<id>` markers. The old ref won't resolve, so `telegram_followups` falls back to the `Chat:` title, exactly as it does today when the allowlist changes. Message IDs are the same Telegram IDs, so the follow-up check works unchanged.
4. Remove the old OAuth `token.json`. Optionally revoke Pennyworth's client in the organization's MCP.

## Tests

- **Unit (vitest):**
  - **guard:** every allowed class passes; every write, read-marking, account or auth class throws. There's a table test of the `NEVER` names.
  - **classifier:** each kind, including replies that are also `mentioned`, alias mentions, bots, broadcast channels, forum topics, and a basic group migrated to a supergroup.
  - **cursors:** reconciliation fills gaps, restart resumes, and new chats start at the top.
  - **views:** before, after, `user_replied_directly`.
  - **tools:** argument validation, and excluded chats are invisible to every tool.
  - Fixtures are recorded from the real account with the text replaced, never real text.
- **Live, before switching the Scout over:**
  1. Run the new service as `telegram-mcp-next` beside the old one for a day.
  2. Compare candidates: the new one should find everything the old one did, plus chats outside the allowlist.
  3. Confirm in the Telegram app that no unread counts or mention badges change, and that the user never shows as online because of Pennyworth.
- `scripts/verify-security.sh` and `scripts/healthcheck.sh` pass.

## Decisions (2026-10-15)

1. **Broadcast channels:** skipped by the scan, readable by agents on request.
2. **Muted and archived chats:** excluded everywhere.
3. **Edits that add a mention:** later.
4. **Board banner:** in v1, with Connect/Reconnect like D-36.
