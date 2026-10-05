import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Read tools exposed by default. Anything not listed is hidden and refused. */
export const DEFAULT_ALLOWLIST = [
  "slack_search_public",
  "slack_search_public_and_private",
  "slack_search_channels",
  "slack_search_users",
  "slack_read_channel",
  "slack_read_thread",
  "slack_read_user_profile",
  "slack_list_user_channels",
];

// Defense in depth: even if an operator adds one of these to the allowlist, it is never exposed.
const NEVER = /(send|post|schedule|update|create|delete|add_|remove|upload|reaction|edit|draft|write|invite|join|leave|archive|complete_file)/i;

/** Allowlisted, non-mutating upstream tools, annotated read-only so Codex runs them unattended. */
export function allowedTools(upstream: Tool[], allowlist: Set<string>): Tool[] {
  return upstream
    .filter((t) => isAllowed(t.name, allowlist))
    .map((t) => ({ ...t, annotations: { ...(t.annotations ?? {}), readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));
}

export function isAllowed(name: string, allowlist: Set<string>): boolean {
  return allowlist.has(name) && !NEVER.test(name);
}
