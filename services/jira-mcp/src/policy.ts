import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Which of Atlassian's MCP tools Pennyworth exposes. Atlassian's server covers Jira, Confluence and
 * Bitbucket; only the Jira tools the user's flow needs are ever listed here, and writes additionally
 * pass the project check in main.ts (JIRA_WRITE_PROJECTS). New upstream tools show up in the connect
 * log to be considered; they are not exposed until added here.
 */
export const DEFAULT_ALLOWLIST: string[] = [];

/** Tools exposed by default (JIRA_TOOL_ALLOWLIST narrows or widens for a test). */
export function allowlist(env: string | undefined): Set<string> {
  return new Set((env ?? DEFAULT_ALLOWLIST.join(",")).split(",").map((s) => s.trim()).filter(Boolean));
}

export function allowedTools(upstream: Tool[], allow: Set<string>): Tool[] {
  return upstream
    .filter((t) => allow.has(t.name))
    .map((t) => ({ ...t, annotations: { ...(t.annotations ?? {}), readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));
}

/** How much of a tool's answer goes back; the rest is cut with a note to narrow it. */
export const MAX_RESULT_CHARS = 200_000;

export function truncateResult<T extends Record<string, unknown>>(result: T, max = MAX_RESULT_CHARS): T {
  if (!Array.isArray(result.content)) return result;
  let left = max;
  let cut = false;
  const content = result.content.map((c: { type?: string; text?: unknown }) => {
    if (c?.type !== "text" || typeof c.text !== "string") return c;
    if (c.text.length <= left) return (left -= c.text.length), c;
    cut = true;
    const text = c.text.slice(0, left);
    left = 0;
    return { ...c, text };
  });
  if (!cut) return result;
  const { structuredContent: _dropped, ...rest } = result;
  return { ...rest, content: [...content.filter((c: { type?: string; text?: unknown }) => c?.type !== "text" || c.text !== ""), { type: "text", text: `[Pennyworth cut this answer at ${max} characters. Return fewer fields or filter in the code.]` }] } as unknown as T;
}
