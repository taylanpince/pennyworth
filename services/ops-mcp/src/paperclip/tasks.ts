import type { Db } from "../db/db.js";
import { nowIso, sha256 } from "../util/ids.js";
import type { Logger } from "../util/log.js";
import type { CreateIssueInput, IssueComment, PaperclipApi } from "./api.js";

export type TaskKind = "action" | "meeting_review" | "routing_review" | "conflict" | "system";

export interface ExternalTaskRow {
  marker: string;
  kind: TaskKind;
  issue_id: string | null;
  issue_ref: string | null;
  status: "open" | "resolved" | "closed" | "pending_create";
  payload_json: string;
  created_at: string;
  updated_at: string;
}

export interface TaskOutcome {
  marker: string;
  issue_id?: string;
  issue_ref?: string;
  state: "created" | "existing" | "pending_create";
}

export interface TaskDraft {
  title: string;
  provenance: { label: string; value: string }[];
  reason: string;
  suggested_action?: string;
  extra_sections?: { heading: string; body: string }[];
  labels: string[];
  assignee_agent_id?: string;
  priority?: CreateIssueInput["priority"];
}

/** Stable, machine-readable marker embedded in every task body (spec §28). */
export const markerComment = (marker: string): string => `<!-- source:${marker} -->`;

export function renderTaskBody(d: TaskDraft, marker: string): string {
  const lines = ["## Source", "", ...d.provenance.map((p) => `${p.label}: ${p.value}`), "", "## Reason", "", d.reason];
  if (d.suggested_action) lines.push("", "## Suggested action", "", d.suggested_action);
  for (const s of d.extra_sections ?? []) lines.push("", `## ${s.heading}`, "", s.body);
  lines.push("", markerComment(marker));
  return lines.join("\n");
}

/**
 * Idempotent Paperclip task creation keyed by a marker. Every task is recorded in
 * SQLite before and after creation so reprocessing never creates duplicates, and
 * creation failures are retried later instead of being lost.
 */
export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly api: PaperclipApi | undefined,
    private readonly log: Logger,
  ) {}

  get(marker: string): ExternalTaskRow | undefined {
    return this.db.prepare("SELECT * FROM external_tasks WHERE marker = ?").get(marker) as ExternalTaskRow | undefined;
  }

  listOpen(kinds: TaskKind[]): ExternalTaskRow[] {
    const ph = kinds.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM external_tasks WHERE status = 'open' AND kind IN (${ph}) ORDER BY created_at`)
      .all(...kinds) as unknown as ExternalTaskRow[];
  }

  async upsert(marker: string, kind: TaskKind, draft: TaskDraft, context: Record<string, unknown> = {}): Promise<TaskOutcome> {
    const existing = this.get(marker);
    if (existing?.issue_id) {
      return { marker, issue_id: existing.issue_id, issue_ref: existing.issue_ref ?? undefined, state: "existing" };
    }
    const payload = JSON.stringify({ draft, context });
    const ts = nowIso();
    if (!existing) {
      this.db
        .prepare(
          "INSERT INTO external_tasks (marker, kind, status, payload_json, created_at, updated_at) VALUES (?, ?, 'pending_create', ?, ?, ?)",
        )
        .run(marker, kind, payload, ts, ts);
    }
    return this.tryCreate(marker, draft);
  }

  /** Retry creations that failed earlier (e.g. Paperclip was down). */
  async retryPending(): Promise<TaskOutcome[]> {
    const rows = this.db.prepare("SELECT * FROM external_tasks WHERE status = 'pending_create'").all() as unknown as ExternalTaskRow[];
    const out: TaskOutcome[] = [];
    for (const row of rows) {
      const { draft } = JSON.parse(row.payload_json) as { draft: TaskDraft };
      out.push(await this.tryCreate(row.marker, draft));
    }
    return out;
  }

  context<T = Record<string, unknown>>(row: ExternalTaskRow): T {
    return (JSON.parse(row.payload_json) as { context: T }).context;
  }

  async userComments(row: ExternalTaskRow): Promise<IssueComment[]> {
    if (!this.api || !row.issue_id) return [];
    const comments = await this.api.listComments(row.issue_id);
    return comments.filter((c) => c.author === "user");
  }

  /**
   * Mark a task resolved locally and try to close it in Paperclip. Paperclip only lets
   * agent keys update other issues inside a heartbeat run, so when the direct close is
   * refused the task is handed to the agent through pendingCloses().
   */
  async resolve(marker: string, note: string): Promise<void> {
    const row = this.get(marker);
    if (!row) return;
    const payload = { ...(JSON.parse(row.payload_json) as Record<string, unknown>), resolution_note: note };
    this.db
      .prepare("UPDATE external_tasks SET status = 'resolved', payload_json = ?, updated_at = ? WHERE marker = ?")
      .run(JSON.stringify(payload), nowIso(), marker);
    if (this.api && row.issue_id) {
      try {
        await this.api.addComment(row.issue_id, note);
        await this.api.setStatus(row.issue_id, "done");
        this.db.prepare("UPDATE external_tasks SET status = 'closed', updated_at = ? WHERE marker = ?").run(nowIso(), marker);
      } catch (err) {
        this.log.info({ marker, err: String(err).slice(0, 200) }, "task resolved locally; the agent will close it in Paperclip");
      }
    }
  }

  /** Record that a user's reply could not be applied (reported once, via the next scan). */
  noteProblem(marker: string, commentId: string, message: string): void {
    const row = this.get(marker);
    if (!row) return;
    const payload = JSON.parse(row.payload_json) as Record<string, unknown> & { problems?: { comment_id: string; message: string; reported: boolean }[] };
    payload.problems ??= [];
    if (payload.problems.some((p) => p.comment_id === commentId)) return;
    payload.problems.push({ comment_id: commentId, message, reported: false });
    this.db.prepare("UPDATE external_tasks SET payload_json = ?, updated_at = ? WHERE marker = ?").run(JSON.stringify(payload), nowIso(), marker);
  }

  /** Unreported problems, marked reported as they are handed out. */
  takeProblems(): { issue_id: string; issue_ref?: string; comment: string }[] {
    const out: { issue_id: string; issue_ref?: string; comment: string }[] = [];
    const rows = this.db.prepare("SELECT * FROM external_tasks WHERE status = 'open' AND payload_json LIKE '%\"reported\":false%'").all() as unknown as ExternalTaskRow[];
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown> & { problems?: { comment_id: string; message: string; reported: boolean }[] };
      for (const p of payload.problems ?? []) {
        if (p.reported || !row.issue_id) continue;
        p.reported = true;
        out.push({ issue_id: row.issue_id, issue_ref: row.issue_ref ?? undefined, comment: p.message });
      }
      this.db.prepare("UPDATE external_tasks SET payload_json = ? WHERE marker = ?").run(JSON.stringify(payload), row.marker);
    }
    return out;
  }

  /** Resolved tasks still open in Paperclip, with the comment the agent should post when closing. */
  async pendingCloses(limit = 10): Promise<{ issue_id: string; issue_ref?: string; comment: string }[]> {
    const rows = this.db
      .prepare("SELECT * FROM external_tasks WHERE status = 'resolved' AND issue_id IS NOT NULL ORDER BY updated_at LIMIT ?")
      .all(limit) as unknown as ExternalTaskRow[];
    const out: { issue_id: string; issue_ref?: string; comment: string }[] = [];
    for (const row of rows) {
      let status = "";
      try {
        status = this.api ? (await this.api.getIssue(row.issue_id!)).status : "";
      } catch {
        continue;
      }
      if (status === "done" || status === "cancelled") {
        this.db.prepare("UPDATE external_tasks SET status = 'closed', updated_at = ? WHERE marker = ?").run(nowIso(), row.marker);
        continue;
      }
      const note = (JSON.parse(row.payload_json) as { resolution_note?: string }).resolution_note ?? "Resolved.";
      out.push({ issue_id: row.issue_id!, issue_ref: row.issue_ref ?? undefined, comment: note });
    }
    return out;
  }

  private async tryCreate(marker: string, draft: TaskDraft): Promise<TaskOutcome> {
    if (!this.api) return { marker, state: "pending_create" };
    try {
      const issue = await this.api.createIssue({
        title: draft.title.slice(0, 200),
        description: renderTaskBody(draft, marker),
        labels: draft.labels,
        // Paperclip enforces uniqueness per company, so a retry after a lost
        // response returns the same issue instead of creating a second one.
        idempotency_key: `pw-${sha256(marker).slice(0, 32)}`,
        assignee_agent_id: draft.assignee_agent_id,
        priority: draft.priority,
      });
      this.db
        .prepare("UPDATE external_tasks SET issue_id = ?, issue_ref = ?, status = 'open', updated_at = ? WHERE marker = ?")
        .run(issue.id, issue.identifier ?? null, nowIso(), marker);
      return { marker, issue_id: issue.id, issue_ref: issue.identifier, state: "created" };
    } catch (err) {
      this.log.warn({ marker, err: String(err) }, "task creation failed; will retry");
      return { marker, state: "pending_create" };
    }
  }
}
