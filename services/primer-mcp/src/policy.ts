import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Tools that only read documents, versions and comments. */
export const READ_TOOLS = [
  "primer_whoami",
  "primer_resolve_url",
  "primer_get_document",
  "primer_get_version_content",
  "primer_list_versions",
  "primer_get_comments",
  "primer_get_document_comments",
  "primer_list_documents",
  "primer_find_document",
];

/** Publishing: a new document, or a new version of one the user owns or edits (D-31). */
export const PUBLISH_TOOLS = ["primer_create_document", "primer_add_version"];

/** Tools exposed by default. Anything not listed is hidden and refused. */
export const DEFAULT_ALLOWLIST = [...READ_TOOLS, ...PUBLISH_TOOLS];

// Defense in depth: even if an operator adds one of these to the allowlist, it is never exposed.
// Events reach other people's open pages; sharing and deletion are the user's to do.
const NEVER = /(delete|remove|share|visibility|collaborator|permission|invite|send_events|token)/i;

/**
 * Allowlisted upstream tools with explicit annotations, so Codex runs them unattended:
 * reads are read-only, publishing writes stay inside Primer (not open-world, not destructive).
 */
export function allowedTools(upstream: Tool[], allowlist: Set<string>): Tool[] {
  return upstream
    .filter((t) => isAllowed(t.name, allowlist))
    .map((t) => ({
      ...t,
      annotations: { ...(t.annotations ?? {}), readOnlyHint: !PUBLISH_TOOLS.includes(t.name), destructiveHint: false, openWorldHint: false },
    }));
}

export function isAllowed(name: string, allowlist: Set<string>): boolean {
  return allowlist.has(name) && !NEVER.test(name);
}
