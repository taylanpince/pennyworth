// GitHub REST client for the Assistant (D-39). It holds the user's own `gh` token, which can do
// anything the user can (push, delete branches, change settings). The only thing standing between
// that token and those requests is `guard`: every request goes through it, and it allows a fixed
// list of read endpoints plus one write, a comment on an issue or pull request. Never call fetch
// with the token anywhere else, and never add a route without checking what it does.
import { readFileSync } from "node:fs";

const API = "https://api.github.com";
const NAME = "[A-Za-z0-9_.-]{1,100}";
const NUM = "[1-9][0-9]{0,9}";

/** Requests the token may make. Anything else is refused before it leaves the process. */
export const ROUTES: { method: "GET" | "POST"; path: RegExp }[] = [
  { method: "GET", path: /^\/user$/ },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/comments$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}$`) },
  { method: "GET", path: new RegExp(`^/repos/${NAME}/${NAME}/pulls/${NUM}/reviews$`) },
  { method: "GET", path: /^\/search\/issues$/ },
  // The one write: a new comment on an issue or pull request, in the user's allowed organizations.
  { method: "POST", path: new RegExp(`^/repos/${NAME}/${NAME}/issues/${NUM}/comments$`) },
];

export class GitHubRefused extends Error {}
export class GitHubAuthError extends Error {}

export function guard(method: string, path: string): void {
  if (!ROUTES.some((r) => r.method === method && r.path.test(path))) throw new GitHubRefused(`refused a GitHub request that isn't allowed: ${method} ${path}`);
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

  async request<T>(method: "GET" | "POST", path: string, opts: { query?: Record<string, string | number>; body?: unknown } = {}): Promise<T> {
    guard(method, path);
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
    return (await res.json()) as T;
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
