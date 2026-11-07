import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** The OAuth scope Pennyworth asks ClickHouse Cloud for: its MCP server, nothing else (not ClickStack). */
export const SCOPES = ["mcp:access"];

/**
 * ClickHouse Cloud tools that only read: the organization's services, their databases and tables,
 * and SELECT queries (checked again by checkQuery). Everything else is hidden and refused: costs,
 * backups, ClickPipes, Managed Postgres, and anything the hosted server adds that changes things.
 */
export const READ_TOOLS = ["get_organizations", "get_services_list", "get_service_details", "list_databases", "list_tables", "run_select_query"];

/** Tools exposed by default. */
export const DEFAULT_ALLOWLIST = [...READ_TOOLS];

// Defense in depth: even if an operator adds one of these to the allowlist, it is never exposed.
const NEVER = /(creat|add_|update|delete|remove|manage|exec|write|edit|patch|send|post|start|stop|restart|scale|reset|rotate|grant|revoke|insert|alter|drop|backup|clickpipe|cost)/i;

/** Allowlisted upstream tools, annotated read-only and closed-world so Codex runs them unattended. */
export function allowedTools(upstream: Tool[], allowlist: Set<string>): Tool[] {
  return upstream
    .filter((t) => isAllowed(t.name, allowlist))
    .map((t) => ({ ...t, annotations: { ...(t.annotations ?? {}), readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));
}

export function isAllowed(name: string, allowlist: Set<string>): boolean {
  return allowlist.has(name) && !NEVER.test(name);
}

/** The longest a query may run (seconds), whatever the caller asks: production is shared. */
export const MAX_TIMEOUT_SECONDS = 120;

/** How much of a tool's answer goes back to the job; the rest is cut with a note to aggregate or LIMIT. */
export const MAX_RESULT_CHARS = 200_000;

/**
 * Table functions that reach outside the database: a SELECT through one of them can send data
 * anywhere (`url('https://…/?d=' || secret)`) or read the server's files. ClickHouse calls them from
 * any SELECT, so they are refused by name, along with their *Cluster and engine-specific variants.
 */
const EXTERNAL = /\b(url\w*|s3\w*|gcs\w*|oss\w*|cosn?|azure\w*|remote\w*|mysql\w*|postgresql\w*|mongodb\w*|redis\w*|jdbc|odbc|hdfs\w*|file\w*|executable\w*|iceberg\w*|deltalake\w*|hudi\w*|paimon\w*|hive\w*|sqlite|ytsaurus|arrowflight\w*|kafka|nats|rabbitmq|input)\s*\(/i;

/** How a query may start: reads only. */
const READ_START = /^(select|with|show|describe|desc|explain|exists)\b/i;

export class QueryRefused extends Error {}

/**
 * The query as ClickHouse reads it, without comments, with string literals emptied (so their text
 * can't hide or fake a keyword) and quoted identifiers unquoted (so `url`(…) is still url(…)).
 */
export function normalize(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const two = sql.slice(i, i + 2);
    if (two === "--" || c === "#") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
      out += " ";
    } else if (two === "/*") {
      // ClickHouse nests block comments.
      let depth = 0;
      while (i < sql.length) {
        if (sql.startsWith("/*", i)) (depth++, (i += 2));
        else if (sql.startsWith("*/", i)) {
          i += 2;
          if (--depth === 0) break;
        } else i++;
      }
      if (depth > 0) throw new QueryRefused("unterminated comment");
      out += " ";
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      let text = "";
      for (; j < sql.length; j++) {
        if (sql[j] === "\\") (text += sql[j + 1] ?? ""), j++;
        else if (sql[j] === c && sql[j + 1] === c) (text += c), j++;
        else if (sql[j] === c) break;
        else text += sql[j];
      }
      if (j >= sql.length) throw new QueryRefused("unterminated quote");
      out += c === "'" ? "''" : text;
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Pennyworth's own check before a query reaches ClickHouse, on top of the hosted tool's SELECT-only
 * rule (which runs under the user's own identity, which can write): one read statement, no table
 * function that reaches outside the database, no SETTINGS overrides and no output files.
 */
export function checkQuery(sql: string): void {
  const q = normalize(sql).replace(/;\s*$/, "");
  if (!q) throw new QueryRefused("empty query");
  if (q.includes(";")) throw new QueryRefused("one statement per query");
  if (!READ_START.test(q.replace(/^\(+\s*/, ""))) throw new QueryRefused("only SELECT, WITH, SHOW, DESCRIBE, EXPLAIN and EXISTS queries are allowed");
  const ext = EXTERNAL.exec(q);
  if (ext) throw new QueryRefused(`the table function ${ext[1]}() reaches outside the database and isn't allowed`);
  if (/\bsettings\s+\w+\s*=/i.test(q)) throw new QueryRefused("SETTINGS overrides aren't allowed");
  if (/\binto\s+outfile\b/i.test(q)) throw new QueryRefused("INTO OUTFILE isn't allowed");
}

/**
 * The arguments sent upstream for an allowed call: queries checked, timeouts capped. Throws
 * QueryRefused with a reason the agent can act on.
 */
export function checkCall(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name !== "run_select_query") return args;
  if (typeof args.query !== "string") throw new QueryRefused("query must be a string");
  checkQuery(args.query);
  const asked = Number(args.timeoutSeconds);
  return { ...args, timeoutSeconds: Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), MAX_TIMEOUT_SECONDS) : MAX_TIMEOUT_SECONDS };
}

/**
 * A tool's answer cut to MAX_RESULT_CHARS of text, with a note saying so: a SELECT without a LIMIT
 * shouldn't fill the job's context. Structured content is dropped when the text is cut.
 */
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
  return { ...rest, content: [...content.filter((c: { type?: string; text?: unknown }) => c?.type !== "text" || c.text !== ""), { type: "text", text: `[Pennyworth cut this answer at ${max} characters. Aggregate, select fewer columns or add a LIMIT.]` }] } as unknown as T;
}
