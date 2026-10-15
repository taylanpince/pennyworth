import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Glean tools that only read the user's company knowledge: search, a document, people, meetings,
 * code, and Glean's own answer over those (chat). Everything else is hidden and refused.
 */
export const READ_TOOLS = ["search", "read_document", "employee_search", "meeting_lookup", "code_search", "chat"];

/** Tools exposed by default. */
export const DEFAULT_ALLOWLIST = [...READ_TOOLS];

// Defense in depth: even if an operator adds one of these to the allowlist, it is never exposed.
// Glean servers can carry write tools (artifacts, images, memory) and gateway tools that act in
// other apps (Slack sends, Jira edits); none belong to Pennyworth.
const NEVER = /(create|edit|update|upload|share|delete|remove|send|post|write|memory|artifact|image|schedule|invite|token)/i;

/** Allowlisted upstream tools, annotated read-only and closed-world so Codex runs them unattended. */
export function allowedTools(upstream: Tool[], allowlist: Set<string>): Tool[] {
  return upstream
    .filter((t) => isAllowed(t.name, allowlist))
    .map((t) => ({ ...t, annotations: { ...(t.annotations ?? {}), readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));
}

export function isAllowed(name: string, allowlist: Set<string>): boolean {
  return allowlist.has(name) && !NEVER.test(name);
}
