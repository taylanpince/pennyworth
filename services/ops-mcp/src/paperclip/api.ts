/** Minimal Paperclip surface used by ops-mcp. Implemented over HTTP and by a test fake. */
export interface IssueRef {
  id: string;
  identifier?: string;
  status: string;
}

export interface IssueComment {
  id: string;
  body: string;
  author: "user" | "agent" | "system";
  created_at: string;
}

export interface CreateIssueInput {
  title: string;
  description: string;
  labels: string[]; // label names; created on demand
  idempotency_key: string;
  assignee_agent_id?: string;
  priority?: "low" | "medium" | "high" | "critical";
}

export interface PaperclipApi {
  createIssue(input: CreateIssueInput): Promise<IssueRef>;
  getIssue(id: string): Promise<IssueRef>;
  listComments(issueId: string): Promise<IssueComment[]>;
  addComment(issueId: string, body: string): Promise<void>;
  setStatus(issueId: string, status: "todo" | "in_progress" | "in_review" | "done" | "cancelled" | "blocked"): Promise<void>;
  ping(): Promise<boolean>;
  /** Start a run of one of this agent's routines now (by title). */
  runRoutine(title: string): Promise<void>;
}

export class PaperclipUnavailableError extends Error {}
