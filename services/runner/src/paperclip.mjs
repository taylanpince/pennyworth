import { readFileSync } from "node:fs";
import { RUNNER_MARKER } from "./commands.mjs";

/** Paperclip REST client acting as the user (board API key). */
export class Paperclip {
  constructor(cfg) {
    this.base = cfg.paperclipUrl;
    this.company = cfg.companyId;
    this.key = readFileSync(cfg.boardKeyFile, "utf8").trim();
    this.labels = undefined;
  }

  async api(method, path, body) {
    const res = await fetch(new URL(path, this.base), {
      method,
      headers: { authorization: `Bearer ${this.key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Paperclip ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  async labelId(name) {
    this.labels ??= new Map((await this.api("GET", `/api/companies/${this.company}/labels`)).map((l) => [l.name, l.id]));
    const id = this.labels.get(name);
    if (!id) throw new Error(`label "${name}" missing in Paperclip (run scripts/paperclip-setup.mjs)`);
    return id;
  }

  async labelledIssues(label, updatedSince) {
    const q = new URLSearchParams({ labelId: await this.labelId(label), status: "backlog,todo,in_progress,in_review,blocked", limit: "200" });
    if (updatedSince) q.set("updatedSince", updatedSince);
    return this.api("GET", `/api/companies/${this.company}/issues?${q}`);
  }

  issue(id) {
    return this.api("GET", `/api/issues/${encodeURIComponent(id)}`);
  }

  async comments(issueId) {
    const list = await this.api("GET", `/api/issues/${encodeURIComponent(issueId)}/comments?order=asc&limit=500`);
    return list.filter((c) => !c.deletedAt);
  }

  /** Instructions are only ever taken from human-written comments that are not the runner's own. */
  static isUserInstruction(c) {
    return c.authorType === "user" && !String(c.body ?? "").includes(RUNNER_MARKER);
  }

  comment(issueId, body) {
    return this.api("POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, { body: `${body}\n\n${RUNNER_MARKER}` });
  }

  async me() {
    this.userId ??= (await this.api("GET", "/api/cli-auth/me")).userId;
    return this.userId;
  }

  /** Mark a task in progress (Paperclip requires an assignee for that: the user). */
  async startWork(issueId, comment) {
    return this.api("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, {
      status: "in_progress",
      assigneeUserId: await this.me(),
      assigneeAgentId: null,
      comment: `${comment}\n\n${RUNNER_MARKER}`,
    });
  }

  setStatus(issueId, status, comment) {
    const body = { status };
    if (comment) body.comment = `${comment}\n\n${RUNNER_MARKER}`;
    return this.api("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, body);
  }
}
