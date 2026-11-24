import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Buildkite's hosted MCP server offers two OAuth scopes, `read` and `write` (its metadata's
 * scopes_supported on 2026-11-24). Pennyworth asks for `read` and nothing else, and reaches the server's
 * read-only endpoint (/mcp/readonly), so Buildkite itself refuses every change: no retries, rebuilds,
 * cancels, unblocks, pipeline or cluster edits.
 */
export const READ_SCOPE = "read";

/** The scopes Pennyworth asks for, among those Buildkite offers. */
export function readScopes(supported: string[]): string[] {
  return supported.includes(READ_SCOPE) ? [READ_SCOPE] : [];
}

/** Scopes in a token response that aren't the read scope (a sign-in that got any is refused). */
export function writeScopes(granted: string): string[] {
  return granted.split(/\s+/).filter((s) => s && s !== "offline_access" && s !== READ_SCOPE && !/^read_[a-z_]+$/.test(s));
}

/**
 * Buildkite's read tools (buildkite.com/docs/apis/mcp-server/tools, 2026-11-24): pipelines, builds, jobs,
 * their logs, artifacts, annotations, Test Engine, agents and clusters. Left out on purpose:
 * `access_token` (hands back the token itself), `get_job_env` (a job's environment carries secrets) and
 * the cluster secret tools.
 */
export const READ_TOOLS = [
  "current_user",
  "user_token_organization",
  "list_pipelines",
  "get_pipeline",
  "list_pipeline_schedules",
  "get_pipeline_schedule",
  "list_builds",
  "get_build",
  "get_build_test_engine_runs",
  "list_jobs",
  "get_job",
  "search_logs",
  "tail_logs",
  "read_logs",
  "list_artifacts_for_build",
  "list_artifacts_for_job",
  "get_artifact",
  "list_annotations",
  "list_tests",
  "get_test",
  "list_test_runs",
  "get_test_run",
  "get_failed_executions",
  "list_agents",
  "get_agent",
  "list_clusters",
  "get_cluster",
  "list_cluster_queues",
  "get_cluster_queue",
  "list_cache_registries",
  "get_cache_registry",
];

/** Tools exposed by default. */
export const DEFAULT_ALLOWLIST = [...READ_TOOLS];

// Defense in depth: even if an operator adds one of these to the allowlist, it is never exposed.
const NEVER = /(creat|update|delete|cancel|rebuild|retry|unblock|pause|resume|set_default|write|^access_token$|secret|_env$)/i;

/** Allowlisted upstream tools, annotated read-only and closed-world so Codex runs them unattended. */
export function allowedTools(upstream: Tool[], allowlist: Set<string>): Tool[] {
  return upstream
    .filter((t) => isAllowed(t.name, allowlist))
    .map((t) => ({ ...t, annotations: { ...(t.annotations ?? {}), readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));
}

export function isAllowed(name: string, allowlist: Set<string>): boolean {
  return allowlist.has(name) && !NEVER.test(name);
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
  return { ...rest, content: [...content.filter((c: { type?: string; text?: unknown }) => c?.type !== "text" || c.text !== ""), { type: "text", text: `[Pennyworth cut this answer at ${max} characters. Search or tail the log, or page through it.]` }] } as unknown as T;
}
