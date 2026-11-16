import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Which of Cloudflare's OAuth scopes Pennyworth asks for: every read, nothing else. Cloudflare names
 * them `<product>.read` (184 of them on 2026-11-16), `<product>.metadata_read` and
 * `workers-scripts.content_read` (a Worker's code), plus `user:read` and `account:read`. Writes,
 * runs, purges, revokes, sends, admin and the oddly named ones (`page.shield`) never match, so
 * Cloudflare itself refuses every change, whatever code the execute tool runs.
 */
export const READ_SCOPE = /^(user:read|account:read|[a-z0-9_-]+\.(read|metadata_read|content_read))$/;

/** The read scopes among those Cloudflare offers (its metadata's scopes_supported). */
export function readScopes(supported: string[]): string[] {
  return supported.filter((s) => READ_SCOPE.test(s));
}

/**
 * Cloudflare's API MCP server (mcp.cloudflare.com, Code Mode): `search` the API's OpenAPI spec,
 * `execute` JavaScript that calls the API with the user's token, Cloudflare's `docs`, and `whoami`.
 * execute runs any request, so the token's scopes are the boundary, not this list.
 */
export const READ_TOOLS = ["search", "execute", "docs", "whoami"];

/** Tools exposed by default. */
export const DEFAULT_ALLOWLIST = [...READ_TOOLS];

// Defense in depth: even if an operator adds one of these to the allowlist, it is never exposed.
const NEVER = /(creat|add_|update|delete|remove|manage|write|edit|patch|send|post|purge|deploy|upload|rotate|grant|revoke)/i;

/** Allowlisted upstream tools, annotated read-only and closed-world so Codex runs them unattended. */
export function allowedTools(upstream: Tool[], allowlist: Set<string>): Tool[] {
  return upstream
    .filter((t) => isAllowed(t.name, allowlist))
    .map((t) => ({ ...t, annotations: { ...(t.annotations ?? {}), readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));
}

export function isAllowed(name: string, allowlist: Set<string>): boolean {
  return allowlist.has(name) && !NEVER.test(name);
}

/** Scopes in a token response that aren't reads (a sign-in that got any is refused). */
export function writeScopes(granted: string): string[] {
  return granted.split(/\s+/).filter((s) => s && s !== "offline_access" && !READ_SCOPE.test(s));
}

/** How much of a tool's answer goes back to the job; the rest is cut with a note to narrow it. */
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
