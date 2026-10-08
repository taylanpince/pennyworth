import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Read tools exposed by default. Anything not listed is hidden and refused. */
export const DEFAULT_ALLOWLIST = ["list_allowed_chats", "read_chat_history", "search_chat_history", "get_new_messages"];

// Defense in depth: even if an operator adds one of these to the allowlist, it is never exposed.
// Drafts land in the user's real Telegram, and the allowlist is the user's to change.
const NEVER = /(send|post|draft|reply|forward|edit|delete|create|update|remove|write|react|pin|join|leave|invite|allowed_chats_change|request_|upload|schedule)/i;

/** Allowlisted, non-mutating upstream tools, annotated read-only so Codex runs them unattended. */
export function allowedTools(upstream: Tool[], allowlist: Set<string>): Tool[] {
  return upstream
    .filter((t) => isAllowed(t.name, allowlist))
    .map((t) => ({ ...t, annotations: { ...(t.annotations ?? {}), readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));
}

export function isAllowed(name: string, allowlist: Set<string>): boolean {
  return allowlist.has(name) && !NEVER.test(name);
}
