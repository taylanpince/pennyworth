/** The few Paperclip REST calls the board makes, as the user (board API key). */

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface Agent {
  id: string;
  name: string;
  status: string;
  adapterType: string;
  adapterConfig?: Record<string, unknown>;
  metadata?: { setupKey?: string; models?: unknown } | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  descriptionTruncated?: boolean;
  status: string;
  priority: string;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
  assigneeAdapterOverrides: { adapterConfig?: Record<string, unknown> } | null;
  labels?: Label[];
  labelIds?: string[];
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  createdByUserId?: string | null;
  /** "routine_execution" for a routine's run task. */
  originKind?: string | null;
}

/** An agent run in progress (Paperclip's live-runs). */
export interface LiveRun {
  id: string;
  status: string;
  agentId: string;
  agentName?: string;
  issueId: string | null;
  startedAt: string | null;
  createdAt: string;
  currentStatusMessage?: string | null;
  currentToolName?: string | null;
  lastAssistantSnippet?: string | null;
  outputSilence?: { level?: string } | null;
}

/** A finished (or failed) agent run, from heartbeat-runs. */
export interface PastRun {
  id: string;
  status: string;
  agentId: string;
  issueId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface Comment {
  id: string;
  body: string;
  authorType: string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  createdAt: string;
  deletedAt?: string | null;
}

export interface Model {
  id: string;
  label: string;
}

/** A file on a task (Paperclip stores it; the board uploads the user's). */
export interface Attachment {
  id: string;
  issueId: string;
  originalFilename: string | null;
  contentType: string;
  byteSize: number;
  createdAt: string;
  createdByUserId?: string | null;
  createdByAgentId?: string | null;
}

const OPEN = "backlog,todo,in_progress,in_review,blocked";

export class PaperclipError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class Paperclip {
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly baseUrl: string,
    private readonly companyId: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      headers: { authorization: `Bearer ${this.key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? message;
      } catch {}
      throw new PaperclipError(`Paperclip ${method} ${path.split("?")[0]} → ${res.status}: ${message}`, res.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  me(): Promise<string> {
    return this.cached("me", 3_600_000, async () => (await this.request<{ userId: string }>("GET", "/api/cli-auth/me")).userId);
  }

  company(): Promise<{ issuePrefix?: string; name?: string }> {
    return this.cached("company", 3_600_000, () => this.request("GET", `/api/companies/${this.companyId}`));
  }

  agents(): Promise<Agent[]> {
    return this.cached("agents", 300_000, () => this.request<Agent[]>("GET", `/api/companies/${this.companyId}/agents`));
  }

  labels(): Promise<Label[]> {
    return this.cached("labels", 300_000, () => this.request<Label[]>("GET", `/api/companies/${this.companyId}/labels`));
  }

  models(adapterType: string): Promise<Model[]> {
    return this.cached(`models:${adapterType}`, 600_000, () => this.request<Model[]>("GET", `/api/companies/${this.companyId}/adapters/${adapterType}/models`));
  }

  /**
   * All open issues of the company (routine runs left out), in one request: Paperclip limits
   * concurrent list requests per client, so the board filters by assignee itself.
   */
  openIssues(): Promise<Issue[]> {
    return this.list(OPEN);
  }

  closedSince(since: string): Promise<Issue[]> {
    return this.list("done,cancelled", since, "100");
  }

  private list(status: string, updatedSince?: string, limit = "500"): Promise<Issue[]> {
    const q = new URLSearchParams({ status, limit, excludeRoutineExecutions: "true" });
    if (updatedSince) q.set("updatedSince", updatedSince);
    return this.request<Issue[]>("GET", `/api/companies/${this.companyId}/issues?${q}`);
  }

  /** Agent runs in progress. Polled often, so cached briefly. */
  liveRuns(): Promise<LiveRun[]> {
    return this.cached("live-runs", 3_000, () => this.request<LiveRun[]>("GET", `/api/companies/${this.companyId}/live-runs`));
  }

  /** The newest agent runs, finished or not. */
  recentRuns(limit = 30): Promise<PastRun[]> {
    return this.cached(`runs:${limit}`, 10_000, async () => {
      const raw = await this.request<(PastRun & { contextSnapshot?: { issueId?: string } | null })[]>("GET", `/api/companies/${this.companyId}/heartbeat-runs?limit=${limit}`);
      return raw.map((r) => ({ id: r.id, status: r.status, agentId: r.agentId, issueId: r.contextSnapshot?.issueId ?? null, startedAt: r.startedAt, finishedAt: r.finishedAt, error: r.error ? String(r.error).slice(0, 200) : null }));
    });
  }

  /** An issue's title and origin, which rarely change: cached for a minute. */
  issueSummary(id: string): Promise<Issue> {
    return this.cached(`issue:${id}`, 60_000, () => this.issue(id));
  }

  issue(id: string): Promise<Issue> {
    return this.request<Issue>("GET", `/api/issues/${encodeURIComponent(id)}`);
  }

  async comments(id: string): Promise<Comment[]> {
    const list = await this.request<Comment[]>("GET", `/api/issues/${encodeURIComponent(id)}/comments?order=asc&limit=500`);
    return list.filter((c) => !c.deletedAt);
  }

  updateIssue(id: string, body: Record<string, unknown>): Promise<Issue> {
    return this.request<Issue>("PATCH", `/api/issues/${encodeURIComponent(id)}`, body);
  }

  addComment(id: string, body: string): Promise<Comment> {
    return this.request<Comment>("POST", `/api/issues/${encodeURIComponent(id)}/comments`, { body });
  }

  createIssue(body: Record<string, unknown>): Promise<Issue> {
    return this.request<Issue>("POST", `/api/companies/${this.companyId}/issues`, body);
  }

  attachments(id: string): Promise<Attachment[]> {
    return this.request<Attachment[]>("GET", `/api/issues/${encodeURIComponent(id)}/attachments`);
  }

  async addAttachment(issueId: string, name: string, type: string, data: Buffer): Promise<Attachment> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)], { type }), name);
    const path = `/api/companies/${this.companyId}/issues/${encodeURIComponent(issueId)}/attachments`;
    const res = await this.fetchImpl(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? message;
      } catch {}
      throw new PaperclipError(`Paperclip POST attachment → ${res.status}: ${message}`, res.status);
    }
    return JSON.parse(text) as Attachment;
  }

  async attachmentContent(id: string): Promise<Buffer> {
    const res = await this.fetchImpl(new URL(`/api/attachments/${encodeURIComponent(id)}/content`, this.baseUrl), {
      headers: { authorization: `Bearer ${this.key}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new PaperclipError(`Paperclip GET attachment → ${res.status}`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }
}
