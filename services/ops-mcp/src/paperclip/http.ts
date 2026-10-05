import type { CreateIssueInput, IssueComment, IssueRef, PaperclipApi } from "./api.js";
import { PaperclipUnavailableError } from "./api.js";

interface Label {
  id: string;
  name: string;
}

/** Paperclip REST client (agent API key, bearer auth). */
export class HttpPaperclipApi implements PaperclipApi {
  private labelCache = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    private readonly companyId: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 15_000,
  ) {}

  async createIssue(input: CreateIssueInput): Promise<IssueRef> {
    const labelIds = await Promise.all(input.labels.map((l) => this.labelId(l)));
    const body: Record<string, unknown> = {
      title: input.title,
      description: input.description,
      status: "todo",
      labelIds,
      idempotencyKey: input.idempotency_key,
      allowDuplicate: true, // our own markers handle dedup; titles may legitimately repeat
    };
    if (input.priority) body.priority = input.priority;
    // Assign to the user unless an agent is named: Paperclip otherwise assigns issues to the
    // creating agent, and the user's comments would wake that agent instead of reaching ops-mcp.
    if (input.assignee_agent_id) body.assigneeAgentId = input.assignee_agent_id;
    else {
      const user = await this.ownerUserId();
      if (user) body.assigneeUserId = user;
    }
    const issue = await this.request<Record<string, unknown>>("POST", `/api/companies/${this.companyId}/issues`, body);
    return toRef(issue);
  }

  private owner?: string | null;

  /** The company's default responsible user (the human owner of this instance). */
  private async ownerUserId(): Promise<string | undefined> {
    if (this.owner === undefined) {
      try {
        this.owner = (await this.request<{ defaultResponsibleUserId?: string }>("GET", `/api/companies/${this.companyId}`)).defaultResponsibleUserId ?? null;
      } catch {
        return undefined;
      }
    }
    return this.owner ?? undefined;
  }

  async getIssue(id: string): Promise<IssueRef> {
    return toRef(await this.request<Record<string, unknown>>("GET", `/api/issues/${encodeURIComponent(id)}`));
  }

  async listComments(issueId: string): Promise<IssueComment[]> {
    const raw = await this.request<unknown>("GET", `/api/issues/${encodeURIComponent(issueId)}/comments?order=asc&limit=200`);
    const list = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
    return list
      .filter((c) => !c.deletedAt)
      .map((c) => ({
        id: String(c.id),
        body: String(c.body ?? ""),
        author: c.authorType === "user" || c.authorType === "agent" ? c.authorType : "system",
        created_at: String(c.createdAt ?? ""),
      }));
  }

  async addComment(issueId: string, body: string): Promise<void> {
    await this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, { body });
  }

  async setStatus(issueId: string, status: string): Promise<void> {
    await this.request("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, { status });
  }

  async ping(): Promise<boolean> {
    try {
      await this.request("GET", `/api/companies/${this.companyId}/labels`);
      return true;
    } catch {
      return false;
    }
  }

  private async labelId(name: string): Promise<string> {
    const cached = this.labelCache.get(name);
    if (cached) return cached;
    const labels = await this.request<Label[]>("GET", `/api/companies/${this.companyId}/labels`);
    for (const l of labels) this.labelCache.set(l.name, l.id);
    const found = this.labelCache.get(name);
    if (found) return found;
    const created = await this.request<Label>("POST", `/api/companies/${this.companyId}/labels`, { name, color: "#6b7280" });
    this.labelCache.set(name, created.id);
    return created.id;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new PaperclipUnavailableError(`Paperclip unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Paperclip ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

function toRef(issue: Record<string, unknown>): IssueRef {
  const i = (issue.issue as Record<string, unknown> | undefined) ?? issue;
  return { id: String(i.id), identifier: i.identifier ? String(i.identifier) : undefined, status: String(i.status ?? "") };
}
