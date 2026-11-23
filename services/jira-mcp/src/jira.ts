// Jira for the Assistant (D-69). It holds the user's Atlassian API token, which can do anything
// the user can in Jira. The only thing standing between that token and Jira is `guard`: every
// request goes through it, and it allows a fixed list of reads (the user's own profile, one issue,
// a JQL search) plus the writes the user can ask for: creating an issue and commenting on one, in
// the projects named in JIRA_WRITE_PROJECTS. Never call fetch with the token anywhere else, and
// never add a route or a body field without checking what it does.
import { readFileSync } from "node:fs";
import { adfFromText, textFromAdf } from "./adf.js";

const KEY = "[A-Z][A-Z0-9]*";
const NUM = "[1-9][0-9]{0,9}";

/** Requests the token may make. Anything else is refused before it leaves the process. */
export const ROUTES: { method: Method; path: RegExp }[] = [
  { method: "GET", path: /^\/rest\/api\/3\/myself$/ },
  { method: "GET", path: new RegExp(`^/rest/api/3/issue/${KEY}-${NUM}$`) },
  { method: "POST", path: /^\/rest\/api\/3\/issue$/ },
  { method: "POST", path: new RegExp(`^/rest/api/3/issue/${KEY}-${NUM}/comment$`) },
  { method: "POST", path: /^\/rest\/api\/3\/search\/jql$/ },
];

type Method = "GET" | "POST";

/** Body fields each request may carry: a new issue only its fixed set of fields, a comment only its body, a search its JQL. */
const BODY_FIELDS: { path: RegExp; method: Method; fields: string[] }[] = [
  { method: "POST", path: /\/rest\/api\/3\/issue$/, fields: ["fields"] },
  { method: "POST", path: /\/comment$/, fields: ["body"] },
  { method: "POST", path: /\/search\/jql$/, fields: ["jql", "maxResults", "fields"] },
];
const ISSUE_FIELDS = ["project", "issuetype", "summary", "description", "labels"];

export class JiraRefused extends Error {}
export class JiraAuthError extends Error {}

export function guard(method: string, path: string, body?: unknown): void {
  if (!ROUTES.some((r) => r.method === method && r.path.test(path))) throw new JiraRefused(`refused a Jira request that isn't allowed: ${method} ${path}`);
  const limit = BODY_FIELDS.find((b) => b.method === method && b.path.test(path));
  if (!limit) return;
  const keys = Object.keys((body as object | undefined) ?? {});
  if (keys.some((k) => !limit.fields.includes(k))) throw new JiraRefused(`refused a Jira request with fields that aren't allowed: ${method} ${path}`);
  // A new issue can only carry the fields a Pennyworth task asks for; everything else a Jira
  // issue can do (assignees, transitions, sprints) stays out.
  if (method === "POST" && /^\/rest\/api\/3\/issue$/.test(path)) {
    const fields = Object.keys((body as { fields?: object } | undefined)?.fields ?? {});
    if (fields.some((f) => !ISSUE_FIELDS.includes(f))) throw new JiraRefused(`refused an issue with fields that aren't allowed: ${fields.join(", ")}`);
  }
}

export interface Auth {
  baseUrl: string;
  email: string;
  token: string;
}

/** Reads the auth file (scripts/jira-auth.sh writes it) on every request, so the file can change without a restart. */
export function readAuth(file: string): Auth {
  let raw = "";
  try {
    raw = readFileSync(file, "utf8").trim();
  } catch {
    // handled below
  }
  let parsed: Partial<Auth> = {};
  try {
    parsed = JSON.parse(raw || "{}") as Partial<Auth>;
  } catch {
    throw new JiraAuthError("jira_auth is not valid JSON; run scripts/jira-auth.sh");
  }
  const { baseUrl, email, token } = parsed;
  if (!baseUrl || !email || !token) throw new JiraAuthError("no Jira sign-in (run scripts/jira-auth.sh)");
  return { baseUrl: baseUrl.replace(/\/+$/, ""), email, token };
}

/** Parses "PROJ-123" or a Jira issue URL (https://…/browse/PROJ-123, or a board URL with selectedIssue=PROJ-123). */
export function parseRef(input: { key?: string; url?: string }): string {
  const text = input.url?.trim() || input.key?.trim() || "";
  const plain = text.replace(/[?#].*$/, "");
  const m = plain.match(new RegExp(`^(?:https?://[^/]+/browse/)?(${KEY}-${NUM})$`)) ?? text.match(new RegExp(`[?&]selectedIssue=((${KEY})-(${NUM}))`));
  if (m) return m[1]!;
  throw new Error("give a Jira issue key (PROJ-123) or URL (https://…/browse/PROJ-123)");
}

type Fetch = typeof fetch;

export class Jira {
  constructor(
    private readonly authFile: string,
    private readonly writeProjects: Set<string>,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private auth(): Auth & { header: string } {
    const { baseUrl, email, token } = readAuth(this.authFile);
    return { baseUrl, email, token, header: "Basic " + Buffer.from(`${email}:${token}`).toString("base64") };
  }

  available(): boolean {
    try {
      this.auth();
      return true;
    } catch {
      return false;
    }
  }

  async request<T>(method: Method, path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    guard(method, path, opts.body);
    const auth = this.auth();
    const url = new URL(path, auth.baseUrl + "/");
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    if (url.origin + url.pathname !== auth.baseUrl + path) throw new JiraRefused(`refused a Jira request that isn't allowed: ${method} ${path}`);
    const res = await this.fetchImpl(url, {
      method,
      redirect: "error",
      headers: { authorization: auth.header, accept: "application/json", "user-agent": "pennyworth-jira-mcp", ...(opts.body ? { "content-type": "application/json" } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 || res.status === 403) throw new JiraAuthError("Jira rejected the sign-in (run scripts/jira-auth.sh)");
    const text = await res.text();
    if (!res.ok) {
      let body: { errorMessages?: string[]; errors?: Record<string, string> } = {};
      try {
        body = JSON.parse(text || "{}");
      } catch {
        // fall through: the detail is the raw text
      }
      const detail = [...(body.errorMessages ?? []), ...Object.entries(body.errors ?? {}).map(([f, m]) => `${f}: ${m}`)].join("; ").slice(0, 300);
      throw new Error(`Jira ${res.status} for ${method} ${path}: ${detail || text.slice(0, 200)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async whoami(): Promise<{ name: string; email: string }> {
    const u = await this.request<{ displayName: string; emailAddress: string }>("GET", "/rest/api/3/myself");
    return { name: u.displayName, email: u.emailAddress };
  }

  private async issue(key: string): Promise<JiraIssue> {
    return this.request<JiraIssue>("GET", `/rest/api/3/issue/${encodeURIComponent(key)}`, { query: { fields: "project,issuetype,status,summary,description,assignee,reporter,created,updated,priority,labels,comment" } });
  }

  private browse(key: string): string {
    return `${readAuth(this.authFile).baseUrl}/browse/${key}`;
  }

  async read(ref: { key?: string; url?: string }, commentLimit = 20): Promise<unknown> {
    const key = parseRef(ref);
    const { key: k, fields } = await this.issue(key);
    const comments = fields.comment.comments;
    const shown = comments.slice(-commentLimit);
    return {
      key: k,
      url: this.browse(k),
      summary: fields.summary,
      status: fields.status?.name,
      issue_type: fields.issuetype?.name,
      assignee: fields.assignee?.displayName ?? null,
      reporter: fields.reporter?.displayName ?? null,
      priority: fields.priority?.name ?? null,
      labels: fields.labels,
      created_at: fields.created,
      updated_at: fields.updated,
      description: textFromAdf(fields.description),
      comments_total: fields.comment.total,
      comments_shown: shown.length,
      comments: shown.map((c) => ({ author: c.author?.displayName ?? null, created_at: c.created, body: textFromAdf(c.body) })),
    };
  }

  async search(jql: string, limit = 20): Promise<unknown> {
    type SearchIssue = { key: string; fields: { summary: string; status?: { name: string }; issuetype?: { name: string }; assignee?: { displayName: string } | null; updated?: string } };
    const res = await this.request<{ issues: SearchIssue[] }>("POST", "/rest/api/3/search/jql", {
      body: { jql, maxResults: Math.min(limit, 50), fields: ["summary", "status", "issuetype", "assignee", "updated"] },
    });
    return {
      total: res.issues.length,
      items: res.issues.map((i) => ({
        key: i.key,
        url: this.browse(i.key),
        title: i.fields.summary,
        status: i.fields.status?.name,
        issue_type: i.fields.issuetype?.name,
        assignee: i.fields.assignee?.displayName ?? null,
        updated_at: i.fields.updated ?? null,
      })),
    };
  }

  private writable(project: string, what: string): void {
    if (!this.writeProjects.has(project.toUpperCase())) throw new JiraRefused(`${what} is limited to ${[...this.writeProjects].join(", ") || "no projects"}; ${project} is read-only`);
  }

  async comment(ref: { key?: string; url?: string }, body: string): Promise<{ url: string }> {
    const key = parseRef(ref);
    const issue = await this.issue(key);
    this.writable(issue.fields.project.key, "commenting");
    const out = await this.request<{ id: number }>("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: { body: adfFromText(body) } });
    return { url: `${this.browse(key)}?focusedCommentId=${out.id}` };
  }

  async createIssue(input: { project: string; issuetype?: string; summary: string; description: string; labels?: string[] }): Promise<{ key: string; url: string }> {
    this.writable(input.project, "opening issues");
    const fields: Record<string, unknown> = {
      project: { key: input.project.toUpperCase() },
      issuetype: { name: input.issuetype?.trim() || "Task" },
      summary: input.summary,
      description: adfFromText(input.description ?? ""),
      ...(input.labels?.length ? { labels: input.labels } : {}),
    };
    const out = await this.request<{ key: string }>("POST", "/rest/api/3/issue", { body: { fields } });
    return { key: out.key, url: this.browse(out.key) };
  }
}

interface JiraIssue {
  key: string;
  fields: {
    project: { key: string };
    issuetype: { name: string };
    status: { name: string };
    summary: string;
    description: unknown;
    assignee: { displayName: string } | null;
    reporter: { displayName: string } | null;
    created: string;
    updated: string;
    priority: { name: string } | null;
    labels: string[];
    comment: { total: number; comments: { author: { displayName: string } | null; created: string; body: unknown }[] };
  };
}
