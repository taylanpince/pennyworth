// Jira for the Assistant (D-69). It holds the user's Atlassian API token, which can do anything
// the user can in Jira. The only thing standing between that token and Jira is `guard`: every
// request goes through it, and it allows a fixed list of reads (the user's own profile, one issue,
// a user search by name, a JQL search) plus the writes the user can ask for: creating an issue
// (optionally under a parent, assigned, and transitioned to a status — a transition is the only
// way Jira sets a status, so it follows the create) and commenting on one, in the projects named
// in JIRA_WRITE_PROJECTS. Never call fetch with the token anywhere else, and never add a route or
// a body field without checking what it does.
import { readFileSync } from "node:fs";
import { adfFromText, textFromAdf } from "./adf.js";

const KEY = "[A-Z][A-Z0-9]*";
const NUM = "[1-9][0-9]{0,9}";

/** Requests the token may make. Anything else is refused before it leaves the process. */
export const ROUTES: { method: Method; path: RegExp }[] = [
  { method: "GET", path: /^\/rest\/api\/3\/myself$/ },
  { method: "GET", path: new RegExp(`^/rest/api/3/issue/${KEY}-${NUM}$`) },
  { method: "GET", path: new RegExp(`^/rest/api/3/issue/${KEY}-${NUM}/transitions$`) },
  // A user search by name, to resolve the assignee the user named to an accountId. The response
  // is narrowed in code to accountId and displayName.
  { method: "GET", path: /^\/rest\/api\/3\/user\/search$/ },
  { method: "POST", path: /^\/rest\/api\/3\/issue$/ },
  { method: "POST", path: new RegExp(`^/rest/api/3/issue/${KEY}-${NUM}/comment$`) },
  { method: "POST", path: new RegExp(`^/rest/api/3/issue/${KEY}-${NUM}/transitions$`) },
  // D-69: changing an existing issue in an allowed project: its parent, its assignee, its status.
  { method: "PUT", path: new RegExp(`^/rest/api/3/issue/${KEY}-${NUM}$`) },
  { method: "PUT", path: new RegExp(`^/rest/api/3/issue/${KEY}-${NUM}/assignee$`) },
  { method: "POST", path: /^\/rest\/api\/3\/search\/jql$/ },
];

type Method = "GET" | "POST" | "PUT";

/** Body fields each request may carry: a new issue only its fixed set of fields, a comment only its body, a search its JQL, a transition only its id. */
const BODY_FIELDS: { path: RegExp; method: Method; fields: string[] }[] = [
  { method: "POST", path: /\/rest\/api\/3\/issue$/, fields: ["fields"] },
  { method: "POST", path: /\/comment$/, fields: ["body"] },
  { method: "POST", path: /\/transitions$/, fields: ["transition"] },
  { method: "POST", path: /\/search\/jql$/, fields: ["jql", "maxResults", "fields"] },
  { method: "PUT", path: new RegExp(`^/rest/api/3/issue/${KEY}-${NUM}/assignee$`), fields: ["accountId"] },
  { method: "PUT", path: new RegExp(`^/rest/api/3/issue/${KEY}-${NUM}$`), fields: ["fields"] },
];
const ISSUE_FIELDS = ["project", "issuetype", "summary", "description", "labels", "parent", "assignee"];

export class JiraRefused extends Error {}
export class JiraAuthError extends Error {}

export function guard(method: string, path: string, body?: unknown): void {
  if (!ROUTES.some((r) => r.method === method && r.path.test(path))) throw new JiraRefused(`refused a Jira request that isn't allowed: ${method} ${path}`);
  const limit = BODY_FIELDS.find((b) => b.method === method && b.path.test(path));
  if (!limit) return;
  const keys = Object.keys((body as object | undefined) ?? {});
  if (keys.some((k) => !limit.fields.includes(k))) throw new JiraRefused(`refused a Jira request with fields that aren't allowed: ${method} ${path}`);
  // A new issue can only carry the fields a Pennyworth task asks for; everything else a Jira
  // issue can do (sprints, due dates, security levels) stays out.
  if (method === "POST" && /^\/rest\/api\/3\/issue$/.test(path)) {
    const fields = Object.keys((body as { fields?: object } | undefined)?.fields ?? {});
    if (fields.some((f) => !ISSUE_FIELDS.includes(f))) throw new JiraRefused(`refused an issue with fields that aren't allowed: ${fields.join(", ")}`);
  }
  // Changing an existing issue only sets its parent here; the assignee goes through her own endpoint.
  if (method === "PUT" && new RegExp(`^/rest/api/3/issue/${KEY}-${NUM}$`).test(path)) {
    const fields = Object.keys((body as { fields?: object } | undefined)?.fields ?? {});
    if (fields.some((f) => f !== "parent")) throw new JiraRefused(`refused changing fields that aren't allowed: ${fields.join(", ")}`);
  }
  // A transition only names the transition id the code picked from the issue's own list.
  if (method === "POST" && /\/transitions$/.test(path) && body !== undefined) {
    const t = (body as { transition?: { id?: unknown } } | undefined)?.transition;
    if (!t || typeof t.id !== "string") throw new JiraRefused("refused a transition without a fixed id");
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

  async whoami(): Promise<{ name: string; email: string; account_id: string }> {
    const u = await this.request<{ displayName: string; emailAddress: string; accountId: string }>("GET", "/rest/api/3/myself");
    return { name: u.displayName, email: u.emailAddress, account_id: u.accountId };
  }

  /** The users a name matches, narrowed to accountId and displayName (the user search returns more). */
  async findUser(name: string): Promise<{ account_id: string; name: string }[]> {
    const users = await this.request<{ accountId: string; displayName: string; active?: boolean }[]>("GET", "/rest/api/3/user/search", { query: { query: name, maxResults: "10" } });
    return users
      .filter((u) => u.active !== false)
      .map((u) => ({ account_id: u.accountId, name: u.displayName }));
  }

  /** A name (or "me") to one accountId, before anything is created; the issue's transitions come from Jira's own list for the issue. */
  private async resolveAssignee(assignee: string): Promise<string> {
    const wanted = assignee.trim();
    if (/^me$/i.test(wanted)) {
      const me = await this.whoami();
      return me.account_id;
    }
    const matches = await this.findUser(wanted);
    const exact = matches.filter((m) => m.name.toLowerCase() === wanted.toLowerCase());
    if (exact.length === 1) return exact[0]!.account_id;
    if (exact.length > 1) throw new JiraRefused(`several users are called "${wanted}": ${matches.map((m) => m.name).join(", ")}; name one exactly`);
    const asId = matches.find((m) => m.account_id === wanted);
    if (asId) return asId.account_id;
    // An accountId can be used as given, without a search.
    if (/^[0-9a-f]+:[0-9a-f-]{30,}$/i.test(wanted)) return wanted;
    throw new JiraRefused(`no user "${wanted}"; ${matches.map((m) => m.name).join(", ") || "nothing similar"}`);
  }

  private async issue(key: string): Promise<JiraIssue> {
    return this.request<JiraIssue>("GET", `/rest/api/3/issue/${encodeURIComponent(key)}`, { query: { fields: "project,issuetype,status,summary,description,assignee,reporter,created,updated,priority,labels,parent,comment" } });
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
      parent: fields.parent?.key ?? null,
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

  /**
   * Changes an existing issue (D-69): its parent, its assignee, its status (through a transition).
   * Everything that can be refused (project, assignee name, the transition) is checked before the
   * first write, and the result reports what changed and the issue's state after.
   */
  async updateIssue(ref: { key?: string; url?: string }, input: { parent?: string; assignee?: string; status?: string }): Promise<unknown> {
    const key = parseRef(ref);
    const before = await this.issue(key);
    this.writable(before.fields.project.key, "changing issues");
    const done: string[] = [];
    // Preflight: resolve everything before anything is written.
    const parent = input.parent ? parseRef({ key: input.parent }) : undefined;
    const accountId = input.assignee ? await this.resolveAssignee(input.assignee) : undefined;
    let transition: { id: string; to: string } | undefined;
    if (input.status) {
      const ts = await this.transitions(key);
      transition = ts.find((t) => Jira.nameKey(t.to) === Jira.nameKey(input.status!)) ?? ts.find((t) => Jira.nameKey(t.name) === Jira.nameKey(input.status!));
      if (!transition) throw new JiraRefused(`no transition to "${input.status}"; its transitions are: ${ts.map((t) => t.to).join(", ") || "(none)"}`);
    }
    if (parent) {
      if (before.fields.parent?.key === parent) done.push(`parent already ${parent}`);
      else {
        await this.request("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}`, { body: { fields: { parent: { key: parent } } } });
        done.push(`parent ${parent}`);
      }
    }
    if (accountId) {
      if (input.assignee && before.fields.assignee?.displayName?.toLowerCase() === input.assignee.trim().toLowerCase()) done.push(`already assigned to ${before.fields.assignee.displayName}`);
      else {
        await this.request("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, { body: { accountId } });
        done.push(`assigned ${input.assignee!.trim()}`);
      }
    }
    if (transition) {
      if (Jira.nameKey(before.fields.status?.name ?? "") === Jira.nameKey(transition.to)) done.push(`already ${transition.to}`);
      else {
        await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { body: { transition: { id: transition.id } } });
        done.push(`status ${transition.to}`);
      }
    }
    const after = await this.issue(key);
    return {
      key: after.key,
      url: this.browse(after.key),
      parent: after.fields.parent?.key ?? null,
      assignee: after.fields.assignee?.displayName ?? null,
      status: after.fields.status?.name,
      done: done.length ? done : ["nothing to change"],
    };
  }

  async comment(ref: { key?: string; url?: string }, body: string): Promise<{ url: string }> {
    const key = parseRef(ref);
    const issue = await this.issue(key);
    this.writable(issue.fields.project.key, "commenting");
    const out = await this.request<{ id: number }>("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: { body: adfFromText(body) } });
    return { url: `${this.browse(key)}?focusedCommentId=${out.id}` };
  }

  /** "Done" and "✔️ Done" are the same status. */
  private static nameKey = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  /** The transitions Jira offers this issue right now; a status can only be reached through one. */
  private async transitions(key: string): Promise<{ id: string; name: string; to: string }[]> {
    const res = await this.request<{ transitions: { id: string; name: string; to: { name: string } }[] }>("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
    return res.transitions.map((t) => ({ id: t.id, name: t.name, to: t.to.name }));
  }

  async createIssue(input: { project: string; issuetype?: string; summary: string; description: string; labels?: string[]; parent?: string; assignee?: string; status?: string }): Promise<IssueCreated> {
    this.writable(input.project, "opening issues");
    // Everything that can be refused is checked before the issue exists.
    const parent = input.parent ? parseRef({ key: input.parent }) : undefined;
    const assignee = input.assignee ? await this.resolveAssignee(input.assignee) : undefined;
    const fields: Record<string, unknown> = {
      project: { key: input.project.toUpperCase() },
      issuetype: { name: input.issuetype?.trim() || "Task" },
      summary: input.summary,
      description: adfFromText(input.description ?? ""),
      ...(input.labels?.length ? { labels: input.labels } : {}),
      ...(parent ? { parent: { key: parent } } : {}),
      ...(assignee ? { assignee: { id: assignee } } : {}),
    };
    const out = await this.request<{ key: string }>("POST", "/rest/api/3/issue", { body: { fields } });
    const created: IssueCreated = { key: out.key, url: this.browse(out.key), ...(parent ? { parent } : {}) };
    if (!input.status) return created;
    // A status is only reachable through a transition of the issue's own workflow; a failure here
    // is returned with the issue rather than thrown: the caller must not open it again.
    try {
      const ts = await this.transitions(out.key);
      const t = ts.find((x) => Jira.nameKey(x.to) === Jira.nameKey(input.status!)) ?? ts.find((x) => Jira.nameKey(x.name) === Jira.nameKey(input.status!));
      if (!t) throw new JiraRefused(`no transition to "${input.status}"; its transitions are: ${ts.map((x) => x.to).join(", ") || "(none)"}`);
      await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(out.key)}/transitions`, { body: { transition: { id: t.id } } });
      created.status = t.to;
    } catch (err) {
      created.status_error = `the issue was opened, but moving it to "${input.status}" failed: ${(err as Error).message.slice(0, 200)}. Don't open it again; tell the user.`;
    }
    return created;
  }
}

export interface IssueCreated {
  key: string;
  url: string;
  parent?: string;
  status?: string;
  status_error?: string;
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
    parent?: { key: string } | null;
    comment: { total: number; comments: { author: { displayName: string } | null; created: string; body: unknown }[] };
  };
}
