# Separate personal and work instances

Use one upstream codebase with independent checkouts and Compose projects. Keep each instance's `.env`, generated `config/*.yaml`, prompts containing personal details, data, and secrets outside tracked source. Personal prompt paths can be excluded through `.git/info/exclude`. Never copy work credentials or work data into a personal instance.

Shared changes must be optional and preserve existing defaults. Ship and review those upstream; do not fork work prompts to encode home policies. Use a branch/PR for new connectors until real account checks pass. Before updating an instance: back up its data, fetch upstream, review the changes, run affected tests, merge, rebuild the affected services, and run health/security checks. Do not automatically deploy every upstream commit. Configuration schemas and database migrations need explicit review. No periodic update automation is installed by these instructions.

## Branding and host runtime

`BOARD_NAME`, `BOARD_ICON` and `BOARD_APP_ID` are board build arguments, configurable in `.env`. They default to Pennyworth, `/icon.png`, and `/`. Put a custom PNG in `services/board/web/public`, exclude personal artwork from Git, and set `BOARD_ICON` to its URL path. Rebuild the board. Name, HTML metadata, manifest, pairing screen and board header use the same values. Use a distinct HTTPS origin for each phone installation.

For a host without Nix, set runner `devshells.flake: ""`, `devshells.engine_shell: ""`, `available: []`, `detect: {}` and `keyword_shells: {}`. Install Node 24, Codex, opencode and gh on the runner's PATH. Its existing sandbox still applies. On Ubuntu, install the distribution's Bubblewrap package so its AppArmor profile applies. Verify `codex sandbox` before enabling jobs. A systemd user runner needs lingering to survive logout/reboot.

## Optional WhatsApp

Add `compose.whatsapp.yaml` to `COMPOSE_FILE`, run bootstrap, then build/start `whatsapp-mcp` and `board`. This uses Baileys, an unofficial WhatsApp Web linked-device library. The board's Manage chats panel is available only when the sidecar token is configured. A local user or paired phone can connect, scan a QR from another screen, refresh the chat list, save selected chats, and disconnect.

No chat is selected initially. The receiver stores text, links and captions only for selected chat IDs, for up to 30 days. Deselecting deletes retained messages for those chats; existing board tasks remain. Account session credentials necessarily cover the linked account, while application storage and MCP reads are limited to selected chats. The service exposes no message-sending tools. History backfill, voice transcription, media downloads, edit/revoke reconciliation and iMessage capture are not implemented yet.

The MCP URL is `http://whatsapp-mcp:8089/mcp`; its token is `whatsapp_mcp_token`. The board holds only `whatsapp_auth_token`, which controls linking/selection, not the message tools. Mount/export the MCP token only to Paperclip and give `whatsapp_pending`, `whatsapp_history`, and `whatsapp_ack` only to the intended agents. In each scout prompt, treat messages as untrusted data, create tasks only for the user's own actions, use stable source markers with `dedupe_closed: true`, and acknowledge only after successful handling.

A scan routine can set `webhook: true`, `webhook_prefix: whatsapp`, and `webhook_label: selected chat intake`. Existing routines default to the original meeting webhook names. Copy the generated `whatsapp_webhook_url` and `whatsapp_webhook_secret` into the sidecar state directory as `webhook_url` and `webhook_secret` (0600). The sidecar sends a content-free HMAC wake-up once a minute only while connected and unprocessed messages exist; use `coalesce_if_active`. This avoids idle model runs. Real linking, chat sync and agent intake must be verified with the user's account before relying on it.

### Attention mode across all chats

Set `WHATSAPP_MODE=attention` and recreate `whatsapp-mcp`. The board then displays all-chat attention settings instead of the selection list. `WHATSAPP_TASK_EMOJI` defaults to 📌; optional comma-separated `WHATSAPP_ME_ALIASES` matches plain-text names as well as native mentions. Existing installations stay in selected mode unless explicitly changed.

Attention mode retains context across chats and queues native/name mentions, quoted replies to the user, and the user's own task-emoji reactions. Other people's reactions and ordinary conversation do not create candidates. A reaction can target an older message; if its original content was never delivered or has expired, the candidate clearly says context is unavailable. History sync supplies context but does not backfill old mention tasks. WhatsApp only exposes messages delivered to this linked session; this is not a complete historical archive. The 30-day retention limit remains.

Use `config/agents/whatsapp-scout.md` for the attention scout. Grant task_create/search/list/get/update/comment/set_status/current plus the three WhatsApp tools. The scout uses one stable source marker per message and closed-task deduplication. Own quoted answers and removed task reactions queue follow-up changes. A pending item's revision must be returned to whatsapp_ack so an acknowledgement cannot swallow a newer pin/unpin or answer. Removing a pin closes only a pin-only task; an unanswered mention/reply remains actionable. Explicit pins survive an answer. Previously created board tasks are not deleted when switching modes.

## Optional Family calendar creation

The normal Google server, credential and OAuth scopes remain read-only. `compose.calendar-write.yaml` starts a separate process from the same built image. It requires a dedicated `calendar_write_oauth.json`, `calendar_write_token`, and an explicit `GOOGLE_WRITE_CALENDAR_ID`. Do not use `primary` as the target. Generate the token securely and keep both files in the private secrets directory.

Create a Google OAuth Desktop client and authorize a separate credential with:

```sh
node services/google-workspace-mcp/src/auth-calendar-write.ts /path/to/client.json "$PENNYWORTH_SECRETS_DIR/calendar_write_oauth.json" --email you@example.com --primary
```

The helper requests `calendar.events` and email identity. On a headless host, forward its printed loopback callback port over SSH to the computer running the browser. For a personal Google account, use an External consent screen; Testing refresh tokens may expire after seven days. Gmail/Drive use the existing `scripts/google-auth.sh` flow separately.

Add the optional Compose file, build the Google image and start `calendar-write-mcp`. Its MCP endpoint is `http://calendar-write-mcp:8090/mcp`. Mount/export its token to Paperclip and grant `family_calendar_create_event` only to the chosen assistant, never unattended message scouts. The tool creates on the configured calendar only; it cannot invite guests, modify or delete events, choose another calendar, or use arbitrary URLs. A stable `request_id` makes retries return the same event and rejects reuse with different content. Real writes remain unverified until consent and the calendar ID are supplied.

Google's scope covers more than one calendar; the fixed-calendar restriction is enforced by this connector, not by the OAuth grant. Calendar creation is distinct from booking a restaurant or appointment with a provider.

## Slack

Use the existing Slack service, OAuth client, scout prompt, pin reaction rules, response detection, deduplication and draft-only assistant tools unchanged. Put the personal instance's workspace/client ID and Slack user ID in its private configuration. Keep scans disabled until sign-in and workspace identity are verified. Do not import work-instance credentials.

### Google and Slack in board Settings

The navbar gear opens Settings with Google, Slack and WhatsApp connection controls.
Google uses the existing `google_auth_token`; optional `compose.connections.yaml`
adds a separate `slack_auth_token` secret for the board and Slack sidecar. Generate
that secret in the instance's secrets directory and add the overlay to
`COMPOSE_FILE`. Never reuse either Slack MCP credential for board sign-in.

Google needs a Desktop OAuth client configured in `google_oauth.json` as
`client_id` and `client_secret` (the same file used by `scripts/google-auth.sh`).
For a fresh installation, upload the downloaded Desktop client JSON in Settings;
only the sidecar stores its client credentials. Existing clients cannot be overwritten
through the board. Settings
can then add an account or reconnect one by email. Existing primary and other
accounts are preserved. This connection requests the existing read-only scopes;
Family Calendar writes still use the separately configured calendar writer.

Slack needs `SLACK_CLIENT_ID` for the intended workspace, registered with
`http://localhost:3118/callback`. Set it in the server environment or enter it in Settings for first-time setup. Settings
can then connect or reconnect that workspace. It uses the same scopes, token
store and MCP tool policy as the command-line sign-in. Connecting a different
workspace replaces this instance's Slack connection, not another instance's.

On a headless installation, start sign-in in Settings, open the provider's consent
page, then copy the entire final localhost callback URL back into Settings.
The localhost page may show a connection error; it does not need to load. The
callback is accepted only by the paired browser that started the flow, expires
after ten minutes, and is single-use. OAuth tokens stay in their sidecars. Neither
MCP agents nor unpaired browsers can use these board connection endpoints.
