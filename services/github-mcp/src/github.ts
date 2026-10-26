// GitHub REST client for the Assistant (D-39). It holds the user's own `gh` token, which can do
// anything the user can (push, delete branches, change settings). The only thing standing between
// that token and those requests is `guard`: every request goes through it, and it allows a fixed
// list of read endpoints plus the writes the user asks for: a comment on an issue or pull request, a
// new issue, and (D-42) adding that issue to an organization project with a status, through the
// GraphQL documents fixed in `GRAPHQL`; and (D-46) closing or reopening an issue, its labels and
// assignees, a review on a pull request, and re-running failed CI jobs. Never call fetch with the
// token anywhere else, and never add a route or a GraphQL document without checking what it does.
import { readFileSync } from "node:fs";

const API = "https://api.github.com";
const NAME = "[A-Za-z0-9_.-]{1,100}";
const NUM = "[1-9][0-9]{0,9}";
const RUN = "[1-9][0-9]{0,15}";
/** A label name in a path, percent-encoded: no slashes. */
const LABEL = "[^/]{1,300}";

/** Requests the token may make. Anything else is refused before it leaves the process. */
export const ROUTES: { method: Method; path: RegExp }[] = [
  { method: "GET", path: /^\/user$/ },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/comments$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}/reviews$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/labels$`) },
  { method: "GET", path: /^\/search\/issues$/ },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/actions/runs$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/actions/runs/${RUN}$`) },
  // The writes, in the user's allowed organizations: a comment, a new issue (D-42), and GraphQL,
  // which `guard` limits to the documents in GRAPHQL.
  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/comments$`) },
  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/issues$`) },
  { method: "POST", path: /^\/graphql$/ },
  // D-46: close or reopen an issue (`guard` allows only state fields in the body), add or remove
  // labels and assignees, review a pull request, re-run a workflow run's failed jobs.
  { method: "PATCH", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}$`) },
  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/labels$`) },
  { method: "DELETE", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/labels/${LABEL}$`) },
  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/assignees$`) },
  { method: "DELETE", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/assignees$`) },
  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}/reviews$`) },
  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/actions/runs/${RUN}/rerun-failed-jobs$`) },
];

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/** Body fields each write may carry: an issue edit can only change its state, a review only its verdict and text. */
const BODY_FIELDS: { path: RegExp; method: Method; fields: string[] }[] = [
  { method: "PATCH", path: /\/issues\/[0-9]+$/, fields: ["state", "state_reason"] },
  { method: "POST", path: /\/pulls\/[0-9]+\/reviews$/, fields: ["event", "body", "commit_id"] },
];

/** The only GraphQL the token may send (D-42): read an organization project, add an issue to it, set its status. */
export const GRAPHQL = {
  project: `query($org: String!, $number: Int!) { organization(login: $org) { projectV2(number: $number) { id title url closed field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } items(last: 50) { nodes { content { ... on Issue { repository { nameWithOwner } } } } } } } }`,
  addItem: `mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }`,
  setStatus: `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) { updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } } }`,
} as const;
const GRAPHQL_DOCS = new Set<string>(Object.values(GRAPHQL));

export class GitHubRefused extends Error {}
export class GitHubAuthError extends Error {}

export function guard(method: string, path: string, body?: unknown): void {
  if (!ROUTES.some((r) => r.method === method && r.path.test(path))) throw new GitHubRefused(`refused a GitHub request that isn't allowed: ${method} ${path}`);
  if (path === "/graphql" && !GRAPHQL_DOCS.has(String((body as { query?: unknown } | undefined)?.query))) throw new GitHubRefused("refused a GraphQL request that isn't one of the fixed documents");
  const limit = BODY_FIELDS.find((b) => b.method === method && b.path.test(path));
  if (limit && Object.keys((body as object | undefined) ?? {}).some((k) => !limit.fields.includes(k))) throw new GitHubRefused(`refused a GitHub request with fields that aren't allowed: ${method} ${path}`);
  if (method === "POST" && /\/reviews$/.test(path) && !["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(String((body as { event?: unknown } | undefined)?.event))) throw new GitHubRefused("refused a review without a verdict");
}

export interface Ref {
  owner: string;
  repo: string;
  number: number;
}

/** Parses "owner/repo#12", an issue or pull request URL, or owner/repo plus a number. */
export function parseRef(input: { url?: string; repo?: string; number?: number }): Ref {
  const re = new RegExp(`^(?:https?://(?:www\\.)?github\\.com/)?(${NAME})/(${NAME})(?:/(?:issues|pull)/|#)(${NUM})(?:[/?#].*)?$`);
  const m = input.url?.trim().match(re);
  if (m) return { owner: m[1]!, repo: m[2]!.replace(/\.git$/, ""), number: Number(m[3]) };
  const r = input.repo?.trim().replace(/^https?:\/\/(?:www\.)?github\.com\//, "").replace(/\/$/, "").match(new RegExp(`^(${NAME})/(${NAME})$`));
  if (r && input.number && Number.isInteger(input.number) && input.number > 0) return { owner: r[1]!, repo: r[2]!, number: input.number };
  throw new Error("give an issue or pull request URL (https://github.com/owner/repo/issues/12), owner/repo#12, or repo (owner/repo) and number");
}

export interface ProjectRef {
  org: string;
  number: number;
}

/** Parses an organization project URL (https://github.com/orgs/acme/projects/16, with or without /views/…). */
export function parseProject(url: string): ProjectRef {
  const m = url.trim().match(new RegExp(`^(?:(?:https?://)?(?:www\\.)?github\\.com/)?orgs/(${NAME})/projects/(${NUM})(?:[/?#].*)?$`));
  if (!m) throw new Error("give an organization project URL (https://github.com/orgs/owner/projects/16); user projects aren't supported");
  return { org: m[1]!, number: Number(m[2]) };
}

/** "🔍  Triage" and "triage" are the same status. */
const statusKey = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

type Fetch = typeof fetch;

export class GitHub {
  constructor(
    private readonly tokenFile: string,
    private readonly commentOrgs: Set<string>,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  /** Read on every request, so `scripts/github-auth.sh` takes effect without a restart. */
  private token(): string {
    let t = "";
    try {
      t = readFileSync(this.tokenFile, "utf8").trim();
    } catch {
      // handled below
    }
    if (!t) throw new GitHubAuthError("no GitHub token (run scripts/github-auth.sh)");
    return t;
  }

  available(): boolean {
    try {
      return Boolean(this.token());
    } catch {
      return false;
    }
  }

  async request<T>(method: Method, path: string, opts: { query?: Record<string, string | number>; body?: unknown } = {}): Promise<T> {
    guard(method, path, opts.body);
    const url = new URL(path, API);
    // ".." passes the name pattern but URL resolution would move the path.
    if (url.origin !== API || url.pathname !== path) throw new GitHubRefused(`refused a GitHub request that isn't allowed: ${method} ${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    const res = await this.fetchImpl(url, {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.token()}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "pennyworth-github-mcp",
        ...(opts.body ? { "content-type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) throw new GitHubAuthError("GitHub rejected the token (run scripts/github-auth.sh)");
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // GitHub answers 404 for private repositories the token can't see.
      throw new Error(`GitHub ${res.status} for ${method} ${url.pathname}${res.status === 404 ? " (not found, or the user has no access)" : ""}: ${detail.slice(0, 200)}`);
    }
    // DELETE …/labels answers with the remaining labels; some writes answer 201/204 with nothing.
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async whoami(): Promise<{ login: string }> {
    const u = await this.request<{ login: string }>("GET", "/user");
    return { login: u.login };
  }

  /** An issue or pull request with its conversation (the latest `limit` comments, oldest first). */
  async read(ref: Ref, limit = 50): Promise<unknown> {
    const base = `/repos/${ref.owner}/${ref.repo}`;
    const issue = await this.request<GhIssue>("GET", `${base}/issues/${ref.number}`);
    const isPr = Boolean(issue.pull_request);
    // Comments come oldest first; fetch the last page(s) so long threads keep their newest.
    const pages = Math.max(1, Math.ceil(issue.comments / 100));
    const comments: GhComment[] = [];
    for (let p = pages; p >= 1 && comments.length < limit; p--) {
      const page = await this.request<GhComment[]>("GET", `${base}/issues/${ref.number}/comments`, { query: { per_page: 100, page: p } });
      comments.unshift(...page);
    }
    const shown = comments.slice(-limit);
    const out: Record<string, unknown> = {
      repo: `${ref.owner}/${ref.repo}`,
      number: issue.number,
      kind: isPr ? "pull_request" : "issue",
      url: issue.html_url,
      title: issue.title,
      state: issue.state,
      state_reason: issue.state_reason ?? undefined,
      author: issue.user?.login,
      labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
      assignees: issue.assignees?.map((a) => a.login),
      milestone: issue.milestone?.title,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      closed_at: issue.closed_at ?? undefined,
      body: issue.body ?? "",
      comments_total: issue.comments,
      comments_shown: shown.length,
      comments: shown.map((c) => ({ id: c.id, author: c.user?.login, created_at: c.created_at, url: c.html_url, body: c.body ?? "" })),
    };
    if (isPr) {
      const pr = await this.request<GhPull>("GET", `${base}/pulls/${ref.number}`);
      const reviews = await this.request<GhReview[]>("GET", `${base}/pulls/${ref.number}/reviews`, { query: { per_page: 100 } });
      out.pull_request = {
        draft: pr.draft,
        merged: pr.merged,
        merged_at: pr.merged_at ?? undefined,
        base: pr.base?.ref,
        head: pr.head?.ref,
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changed_files,
        reviews: reviews.map((r) => ({ author: r.user?.login, state: r.state, submitted_at: r.submitted_at, body: r.body ?? "" })),
      };
    }
    return out;
  }

  async search(query: string, limit = 20): Promise<unknown> {
    const res = await this.request<{ total_count: number; items: GhIssue[] }>("GET", "/search/issues", { query: { q: query, per_page: limit } });
    return {
      total: res.total_count,
      items: res.items.map((i) => ({
        repo: i.repository_url.replace(`${API}/repos/`, ""),
        number: i.number,
        kind: i.pull_request ? "pull_request" : "issue",
        title: i.title,
        state: i.state,
        author: i.user?.login,
        updated_at: i.updated_at,
        url: i.html_url,
      })),
    };
  }

  canComment(ref: Ref): boolean {
    return this.commentOrgs.has(ref.owner.toLowerCase());
  }

  async comment(ref: Ref, body: string): Promise<{ url: string; id: number }> {
    if (!this.canComment(ref)) throw new GitHubRefused(`commenting is limited to ${[...this.commentOrgs].join(", ") || "no organizations"}; ${ref.owner}/${ref.repo} is read-only`);
    const c = await this.request<GhComment>("POST", `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`, { body: { body } });
    return { url: c.html_url, id: c.id };
  }

  private writable(ref: Ref, what: string): void {
    if (!this.canComment(ref)) throw new GitHubRefused(`${what} is limited to ${[...this.commentOrgs].join(", ") || "no organizations"}; ${ref.owner}/${ref.repo} is read-only`);
  }

  /** The repository's labels with their exact names, for matching what the user wrote. */
  private async labels(owner: string, name: string): Promise<string[]> {
    const existing: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.request<{ name: string }[]>("GET", `/repos/${owner}/${name}/labels`, { query: { per_page: 100, page } });
      existing.push(...batch.map((l) => l.name));
      if (batch.length < 100) break;
    }
    return existing;
  }

  /**
   * Changes an issue (D-46): close or reopen it, add or remove labels and assignees. Pull requests
   * take labels and assignees, but closing one isn't done here. Labels must already exist. Checks
   * everything before the first write, and reports each change it made.
   */
  async updateIssue(ref: Ref, input: { state?: "open" | "closed"; reason?: "completed" | "not_planned"; addLabels?: string[]; removeLabels?: string[]; addAssignees?: string[]; removeAssignees?: string[] }): Promise<unknown> {
    this.writable(ref, "changing issues");
    const base = `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
    const issue = await this.request<GhIssue>("GET", base);
    if (input.state && issue.pull_request) throw new GitHubRefused("pull requests aren't closed or reopened from here");
    const current = issue.labels.map((l) => (typeof l === "string" ? l : l.name));
    let add: string[] = [];
    if (input.addLabels?.length) {
      const existing = await this.labels(ref.owner, ref.repo);
      const missing = input.addLabels.filter((l) => !existing.some((e) => e.toLowerCase() === l.trim().toLowerCase()));
      if (missing.length) throw new GitHubRefused(`${ref.owner}/${ref.repo} has no label ${missing.map((m) => `"${m}"`).join(", ")}; its labels: ${existing.slice(0, 40).join(", ") || "(none)"}`);
      add = input.addLabels.map((l) => existing.find((e) => e.toLowerCase() === l.trim().toLowerCase())!);
    }
    const remove = (input.removeLabels ?? []).map((l) => current.find((c) => c.toLowerCase() === l.trim().toLowerCase())).filter((l): l is string => Boolean(l));
    const done: string[] = [];
    if (add.length) await this.request("POST", `${base}/labels`, { body: { labels: add } }), done.push(`added labels ${add.join(", ")}`);
    for (const l of remove) await this.request("DELETE", `${base}/labels/${encodeURIComponent(l)}`), done.push(`removed label ${l}`);
    if (input.addAssignees?.length) await this.request("POST", `${base}/assignees`, { body: { assignees: input.addAssignees } }), done.push(`assigned ${input.addAssignees.join(", ")}`);
    if (input.removeAssignees?.length) await this.request("DELETE", `${base}/assignees`, { body: { assignees: input.removeAssignees } }), done.push(`unassigned ${input.removeAssignees.join(", ")}`);
    if (input.state && input.state !== issue.state) {
      await this.request("PATCH", base, { body: { state: input.state, ...(input.state === "closed" ? { state_reason: input.reason ?? "completed" } : {}) } });
      done.push(input.state === "closed" ? `closed as ${(input.reason ?? "completed").replace("_", " ")}` : "reopened");
    }
    const after = await this.request<GhIssue>("GET", base);
    return { url: after.html_url, state: after.state, labels: after.labels.map((l) => (typeof l === "string" ? l : l.name)), assignees: after.assignees?.map((a) => a.login), done: done.length ? done : ["nothing to change"] };
  }

  /** Submits a review on a pull request as the user (D-46): approve, request changes, or comment. */
  async review(ref: Ref, event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT", body: string): Promise<{ url: string; id: number; state: string }> {
    this.writable(ref, "reviewing");
    const base = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
    const pr = await this.request<GhPull & { state: string; user?: GhUser; head: { sha: string } }>("GET", base);
    if (pr.state !== "open") throw new GitHubRefused(`${ref.owner}/${ref.repo}#${ref.number} isn't open`);
    if (event !== "APPROVE" && !body.trim()) throw new GitHubRefused("a review that requests changes or comments needs text");
    // Reviewed at the head we looked at: if someone pushes meanwhile, GitHub refuses rather than approving unseen commits.
    const r = await this.request<{ id: number; html_url: string; state: string }>("POST", `${base}/reviews`, { body: { event, commit_id: pr.head.sha, ...(body.trim() ? { body } : {}) } });
    return { url: r.html_url, id: r.id, state: r.state };
  }

  /**
   * Re-runs the failed jobs of a pull request's latest workflow runs, or of one workflow run (D-46).
   * Only runs that finished as failed (or were cancelled or timed out) are touched.
   */
  async rerunFailed(input: { pr?: Ref; run?: { owner: string; repo: string; id: number } }): Promise<unknown> {
    type Run = { id: number; name: string; html_url: string; status: string; conclusion: string | null; head_sha: string; workflow_id: number; created_at: string };
    const failed = (r: Run) => r.status === "completed" && ["failure", "cancelled", "timed_out", "startup_failure"].includes(r.conclusion ?? "");
    let owner: string, repo: string, runs: Run[];
    if (input.run) {
      ({ owner, repo } = input.run);
      this.writable({ owner, repo, number: 1 }, "re-running CI");
      runs = [await this.request<Run>("GET", `/repos/${owner}/${repo}/actions/runs/${input.run.id}`)];
    } else if (input.pr) {
      ({ owner, repo } = input.pr);
      this.writable(input.pr, "re-running CI");
      const pr = await this.request<GhPull & { head: { sha: string } }>("GET", `/repos/${owner}/${repo}/pulls/${input.pr.number}`);
      const all = (await this.request<{ workflow_runs: Run[] }>("GET", `/repos/${owner}/${repo}/actions/runs`, { query: { head_sha: pr.head.sha, per_page: 100 } })).workflow_runs;
      // The latest run of each workflow: an older failure that already passed on a re-run doesn't count.
      const latest = new Map<number, Run>();
      for (const r of all) if (!latest.has(r.workflow_id) || latest.get(r.workflow_id)!.created_at < r.created_at) latest.set(r.workflow_id, r);
      runs = [...latest.values()];
    } else throw new Error("give a pull request or a workflow run URL");
    const targets = runs.filter(failed);
    const rerun: { name: string; url: string }[] = [];
    for (const r of targets) {
      await this.request("POST", `/repos/${owner}/${repo}/actions/runs/${r.id}/rerun-failed-jobs`);
      rerun.push({ name: r.name, url: r.html_url });
    }
    return { repo: `${owner}/${repo}`, rerun, not_failed: runs.filter((r) => !failed(r)).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion })) };
  }

  private async graphql<T>(doc: keyof typeof GRAPHQL, variables: Record<string, unknown>): Promise<T> {
    const res = await this.request<{ data?: T; errors?: { message: string }[] }>("POST", "/graphql", { body: { query: GRAPHQL[doc], variables } });
    if (res.errors?.length || !res.data) throw new Error(`GitHub GraphQL: ${res.errors?.map((e) => e.message).join("; ").slice(0, 300) ?? "no data"}`);
    return res.data;
  }

  /**
   * Opens an issue as the user (D-42), with labels, optionally on an organization project with a
   * status. Everything that can be refused (organization, project, status, labels) is checked before
   * the issue exists. The issue can't be undone from here, so a failure after it is created is
   * returned with the issue rather than thrown: the caller must not try again.
   */
  async createIssue(input: { repo?: string; title: string; body: string; labels?: string[]; project?: string; status?: string }): Promise<IssueCreated> {
    const writable = (owner: string) => this.commentOrgs.has(owner.toLowerCase());
    const allowed = [...this.commentOrgs].join(", ") || "no organizations";

    let project: { id: string; title: string; url: string; field?: { id: string; options: { id: string; name: string }[] }; option?: { id: string; name: string }; repos: string[] } | undefined;
    if (input.project) {
      const p = parseProject(input.project);
      if (!writable(p.org)) throw new GitHubRefused(`adding to projects is limited to ${allowed}; ${p.org} is read-only`);
      const data = await this.graphql<{ organization?: { projectV2?: GhProject | null } | null }>("project", { org: p.org, number: p.number });
      const proj = data.organization?.projectV2;
      if (!proj) throw new Error(`project ${p.number} not found in ${p.org} (or the token lacks the project scope: run gh auth refresh -s project, then scripts/github-auth.sh)`);
      if (proj.closed) throw new GitHubRefused(`project "${proj.title}" is closed`);
      const counts = new Map<string, number>();
      for (const n of proj.items.nodes) {
        const r = n.content?.repository?.nameWithOwner;
        if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
      }
      project = { id: proj.id, title: proj.title, url: proj.url, field: proj.field ?? undefined, repos: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r) };
      if (input.status) {
        const options = project.field?.options ?? [];
        project.option = options.find((o) => statusKey(o.name) === statusKey(input.status!));
        if (!project.option) throw new GitHubRefused(`project "${proj.title}" has no status "${input.status}"; its statuses are: ${options.map((o) => o.name).join(", ") || "(no Status field)"}`);
      }
    }

    // Without a repository, the one the project's issues live in.
    const repo = input.repo?.trim().replace(/^https?:\/\/(?:www\.)?github\.com\//, "").replace(/\/$/, "") || project?.repos[0];
    const r = repo?.match(new RegExp(`^(${NAME})/(${NAME})$`));
    if (!r) throw new Error(project ? `name the repository (owner/repo): project "${project.title}" has no issues to take it from` : "name the repository (owner/repo)");
    const [owner, name] = [r[1]!, r[2]!];
    if (!writable(owner)) throw new GitHubRefused(`opening issues is limited to ${allowed}; ${owner}/${name} is read-only`);

    // GitHub would create a missing label; only use the repository's own, with their exact names.
    let labels: string[] = [];
    if (input.labels?.length) {
      const existing = await this.labels(owner, name);
      const missing: string[] = [];
      labels = input.labels.flatMap((l) => {
        const hit = existing.find((e) => e.toLowerCase() === l.trim().toLowerCase());
        if (!hit) missing.push(l);
        return hit ? [hit] : [];
      });
      if (missing.length) throw new GitHubRefused(`${owner}/${name} has no label ${missing.map((m) => `"${m}"`).join(", ")}; its labels: ${existing.slice(0, 40).join(", ") || "(none)"}`);
    }

    const issue = await this.request<GhIssue & { node_id: string }>("POST", `/repos/${owner}/${name}/issues`, { body: { title: input.title, body: input.body, ...(labels.length ? { labels } : {}) } });
    const out: IssueCreated = { repo: `${owner}/${name}`, number: issue.number, url: issue.html_url, labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)) };
    if (!project) return out;
    out.project = { title: project.title, url: project.url };
    try {
      const added = await this.graphql<{ addProjectV2ItemById: { item: { id: string } } }>("addItem", { project: project.id, content: issue.node_id });
      out.project.added = true;
      if (project.option && project.field) {
        await this.graphql("setStatus", { project: project.id, item: added.addProjectV2ItemById.item.id, field: project.field.id, option: project.option.id });
        out.project.status = project.option.name;
      }
    } catch (err) {
      out.project.error = `the issue was opened, but ${out.project.added ? "setting its status" : "adding it to the project"} failed: ${(err as Error).message.slice(0, 200)}. Don't open it again; tell the user.`;
    }
    return out;
  }
}

export interface IssueCreated {
  repo: string;
  number: number;
  url: string;
  labels: string[];
  project?: { title: string; url: string; added?: boolean; status?: string; error?: string };
}
interface GhProject {
  id: string;
  title: string;
  url: string;
  closed: boolean;
  field?: { id: string; options: { id: string; name: string }[] } | null;
  items: { nodes: { content?: { repository?: { nameWithOwner: string } } | null }[] };
}

interface GhUser {
  login: string;
}
interface GhIssue {
  number: number;
  html_url: string;
  repository_url: string;
  title: string;
  state: string;
  state_reason?: string | null;
  user?: GhUser;
  labels: (string | { name: string })[];
  assignees?: GhUser[];
  milestone?: { title: string } | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  body?: string | null;
  comments: number;
  pull_request?: unknown;
}
interface GhComment {
  id: number;
  html_url: string;
  user?: GhUser;
  created_at: string;
  body?: string | null;
}
interface GhPull {
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  base?: { ref: string };
  head?: { ref: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
}
interface GhReview {
  user?: GhUser;
  state: string;
  submitted_at?: string;
  body?: string | null;
}
