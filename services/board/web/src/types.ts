export type Bucket = "triage" | "today" | "tomorrow" | "later" | "backlog";
export const BUCKETS: Bucket[] = ["triage", "today", "tomorrow", "later", "backlog"];
export const BUCKET_NAMES: Record<Bucket, string> = { triage: "Triage", today: "Today", tomorrow: "Tomorrow", later: "Later", backlog: "Backlog" };

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface Assignee {
  key: string;
  kind: "me" | "assistant" | "engineer";
  name: string;
  engine?: "codex" | "claude" | "openrouter";
  defaultModel?: string;
  efforts?: string[];
}

export interface Card {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
  labels: { name: string; color: string }[];
  assignee: string | null;
  executor?: { model?: string; effort?: string };
  unread: boolean;
  createdAt: string;
  activityAt: string;
}

export interface Board {
  buckets: Record<Bucket, Card[]>;
  brief: { id: string; identifier: string; title: string; description: string } | null;
  done: Card[];
  assignees: Assignee[];
  labels: Label[];
  prefix: string;
  timezone: string;
}

export interface CommentView {
  id: string;
  body: string;
  author: { kind: "me" | "runner" | "agent" | "user"; name: string };
  createdAt: string;
}

export interface IssueView extends Card {
  description: string;
  bucket: Bucket | null;
  editable: boolean;
  labelIds: string[];
  replyTarget: string;
  comments: CommentView[];
}

export interface Models {
  default: string | null;
  models: string[];
  efforts: string[];
}

export interface Update {
  title?: string;
  description?: string;
  status?: "todo" | "in_progress" | "done" | "cancelled";
  priority?: "critical" | "high" | "medium" | "low";
  assignee?: string;
  model?: string;
  effort?: string;
  labelIds?: string[];
}
