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
  "slack_send_message_draft", // DRAFT_TOOL: drafts only; per-agent enabled_tools keep it with the Assistant
];

/**
 * The one write (D-46): a draft in the user's own Drafts & Sent, which they edit and send from Slack.
 * Matched by exact name, with only these arguments passed on, so nothing can ask it to send.
 */
export const DRAFT_TOOL = "slack_send_message_draft";
export const DRAFT_ARGS = ["channel_id", "message", "thread_ts"];

/** What /mcp/read serves to the runner's Engineer jobs (D-51): the allowlist without the draft tool. */
export function readOnly(allowlist: Set<string>): Set<string> {
  return new Set([...allowlist].filter((n) => n !== DRAFT_TOOL && !NEVER.test(n)));
}

// Defense in depth: even if an operator adds one of these to the allowlist, it is never exposed.
const NEVER = /(send|post|schedule|update|create|delete|add_|remove|upload|reaction|edit|draft|write|invite|join|leave|archive|complete_file)/i;

/** Allowlisted upstream tools: reads annotated read-only, the draft tool as a local write, so Codex runs them unattended. */
export function allowedTools(upstream: Tool[], allowlist: Set<string>): Tool[] {
  return upstream
    .filter((t) => isAllowed(t.name, allowlist))
    .map((t) =>
      t.name === DRAFT_TOOL
        ? { ...t, description: `${t.description ?? ""}\n\nPennyworth: this only saves a draft for the user to edit and send; it never sends.`.trim(), annotations: { ...(t.annotations ?? {}), readOnlyHint: false, destructiveHint: false, openWorldHint: false } }
        : { ...t, annotations: { ...(t.annotations ?? {}), readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    );
}

export function isAllowed(name: string, allowlist: Set<string>): boolean {
  if (name === DRAFT_TOOL) return allowlist.has(name);
  return allowlist.has(name) && !NEVER.test(name);
}

/** The arguments passed upstream: for the draft tool, only the documented ones. */
export function upstreamArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name !== DRAFT_TOOL) return args;
  const extra = Object.keys(args).filter((k) => !DRAFT_ARGS.includes(k));
  if (extra.length) throw new Error(`refused draft arguments: ${extra.join(", ")}`);
  return args;
}
