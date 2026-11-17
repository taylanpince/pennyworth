import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * The OAuth scopes Pennyworth asks Atlassian's Rovo MCP server for (its resource metadata lists 40 on
 * 2026-11-17): who the user is, Jira read, search and write, Confluence read and search, and Rovo's
 * cross-product search. Never `delete:` or `manage:`, never a Confluence write, nothing for the other
 * products (Bitbucket, JSM, Compass, Loom, goals, Teamwork Graph…).
 */
export const SCOPES = [
  "read:me",
  "read:account",
  "offline_access",
  "read:jira:agent-interface",
  "search:jira:agent-interface",
  "write:jira:agent-interface",
  "read:confluence:agent-interface",
  "search:confluence:agent-interface",
  "search:rovo:agent-interface",
];

/** Scopes in a token response beyond SCOPES (a sign-in that got any is refused). */
export function extraScopes(granted: string): string[] {
  return granted.split(/\s+/).filter((s) => s && !SCOPES.includes(s));
}

/**
 * Reads: Jira issues, JQL search, projects, issue types and fields, transitions, links and people;
 * Confluence pages, spaces, comments and CQL search; Rovo's search and fetch across both; and the
 * accounts and sites the sign-ins reach.
 */
export const READ_TOOLS = [
  "atlassianUserInfo",
  "getAccessibleAtlassianResources",
  "search",
  "fetch",
  "getContentFormatGuide",
  "getJiraIssue",
  "searchJiraIssuesUsingJql",
  "getVisibleJiraProjects",
  "getJiraProjectIssueTypesMetadata",
  "getJiraIssueTypeMetaWithFields",
  "getTransitionsForJiraIssue",
  "getJiraIssueRemoteIssueLinks",
  "getIssueLinkTypes",
  "lookupJiraAccountId",
  "getConfluencePage",
  "getConfluenceSpaces",
  "getPagesInConfluenceSpace",
  "getConfluencePageDescendants",
  "getConfluencePageFooterComments",
  "getConfluencePageInlineComments",
  "getConfluenceCommentChildren",
  "searchConfluenceUsingCql",
];

/** Jira writes, for the Assistant on the user's word (D-69): open, edit, comment, move and link issues. */
export const WRITE_TOOLS = ["createJiraIssue", "editJiraIssue", "addCommentToJiraIssue", "transitionJiraIssue", "createIssueLink"];

/** Tools exposed on /mcp by default. Anything not listed is hidden and refused. */
export const DEFAULT_ALLOWLIST = [...READ_TOOLS, ...WRITE_TOOLS];

/** The allowlist without writes: what /mcp/read serves the runner's Engineer jobs (D-51). */
export function readOnly(allowlist: Set<string>): Set<string> {
  return new Set([...allowlist].filter((n) => READ_TOOLS.includes(n)));
}

// Defense in depth: even if an operator adds one of these to the allowlist, it is never exposed. Deleting,
// worklogs (time booked as the user), Confluence and the other products' writes are the user's to do.
const NEVER = /(delete|remove|worklog|archive|permission|admin|compass|confluence.*(create|update)|(create|update).*confluence|bitbucket|jsm|servicedesk|goal|teamwork)/i;

export function isAllowed(name: string, allowlist: Set<string>): boolean {
  return allowlist.has(name) && !NEVER.test(name);
}

export const isWrite = (name: string) => WRITE_TOOLS.includes(name);

/**
 * Allowlisted upstream tools with explicit annotations, so Codex runs them unattended: reads are
 * read-only, writes stay inside Atlassian (not open-world) and never delete anything.
 */
export function allowedTools(upstream: Tool[], allowlist: Set<string>): Tool[] {
  return upstream
    .filter((t) => isAllowed(t.name, allowlist))
    .map((t) => ({ ...t, annotations: { ...(t.annotations ?? {}), readOnlyHint: !isWrite(t.name), destructiveHint: false, openWorldHint: false } }));
}

/** An Atlassian site a sign-in reaches (getAccessibleAtlassianResources). */
export interface Site {
  id: string;
  url: string;
  name?: string;
}

/**
 * The site a call is for: its `cloudId` (Atlassian accepts the site's id, URL or host name), or the
 * cloud id inside an ARI (`ari:cloud:jira:<cloudId>:issue/…`, what Rovo's search returns for fetch).
 */
export function siteOf(args: Record<string, unknown>): string | undefined {
  if (typeof args.cloudId === "string" && args.cloudId.trim()) return args.cloudId.trim();
  for (const v of [args.id, args.ari]) {
    const m = typeof v === "string" ? /^ari:cloud:[a-z-]+:([0-9a-f-]{36}):/i.exec(v) : null;
    if (m) return m[1];
  }
  return undefined;
}

/** Whether `ref` (an id, URL or host name) names this site. */
export function matchesSite(ref: string, site: Site): boolean {
  const r = ref.toLowerCase().trim();
  if (r === site.id.toLowerCase()) return true;
  const host = (u: string) => {
    try {
      return new URL(/^https?:\/\//.test(u) ? u : `https://${u}`).hostname.toLowerCase();
    } catch {
      return "";
    }
  };
  const h = host(site.url);
  return Boolean(h) && host(r) === h;
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
  return { ...rest, content: [...content.filter((c: { type?: string; text?: unknown }) => c?.type !== "text" || c.text !== ""), { type: "text", text: `[Pennyworth cut this answer at ${max} characters. Ask for fewer fields or results (maxResults, fields).]` }] } as unknown as T;
}
