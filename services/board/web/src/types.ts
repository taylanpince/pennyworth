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
  /** The crew member's name, voice and portrait (D-45). */
  persona?: Persona;
}

export interface Persona {
  name: string;
  voice: string;
  avatar: string;
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
  scheduled?: { date: string; bucket: Bucket };
  recurring?: { summary: string; nextRun: string | null; paused: boolean };
  /** In Today: workdays carried over unfinished (D-28). */
  carried?: number;
  /** An agent is working on it now, or the runner has it queued. */
  working?: Working;
  /** The agents on the task (D-45). */
  crew?: CrewMember[];
}

export type CrewState = "needs" | "failed" | "proposed" | "working" | "queued" | "done";

export interface CrewMember {
  agent: string;
  state: CrewState;
  issues: { id: string; identifier: string; title: string; state: CrewState }[];
  finished?: number;
  since?: string | null;
}

export interface Working {
  agent: string;
  since: string | null;
  queued: boolean;
}

export interface TaskRef {
  identifier: string;
  title?: string;
}

export interface Session {
  id: string;
  source: "agent" | "runner";
  agent: string;
  agentId: string | null;
  state: "working" | "queued";
  startedAt: string | null;
  doing?: string;
  tool?: string;
  said?: string;
  quiet?: boolean;
  run: TaskRef | null;
  tasks: TaskRef[];
}

export interface Finished {
  id: string;
  source: "agent" | "runner";
  agent: string;
  agentId: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  detail?: string;
  run: TaskRef | null;
  tasks: TaskRef[];
}

export interface Agents {
  sessions: Session[];
  finished: Finished[];
  runner: { reportedAt: string | null; stale: boolean };
}

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type Cadence =
  | { kind: "weekly"; weekday: Weekday; interval: number }
  | { kind: "monthly_day"; day: number | "last"; interval: number }
  | { kind: "monthly_weekday"; nth: number | "last"; weekday: Weekday; interval: number };

export interface RecurringView {
  summary: string;
  cadence: Cadence;
  time: string;
  repos: string[];
  paused: boolean;
  nextRun: string | null;
  upcoming: string[];
  runNowPending: boolean;
}

export interface Board {
  buckets: Record<Bucket, Card[]>;
  brief: { id: string; identifier: string; title: string; description: string } | null;
  done: Card[];
  recurring: Card[];
  assignees: Assignee[];
  labels: Label[];
  prefix: string;
  timezone: string;
  /** The next workday, when Tomorrow rolls into Today (D-28). */
  rollsOn: string;
  rollsTomorrow: boolean;
  /** Agent sessions running now. */
  agentsActive: number;
  /** Google sign-in per account (D-36); null when the board can't ask. */
  google: { accounts: GoogleAccount[]; error?: string } | null;
  /** Telegram sign-in (D-37); null when the board can't ask. */
  telegram: TelegramStatus | null;
  /** Glean sign-in (D-38); null when the board can't ask. */
  glean: GleanStatus | null;
}

export interface GleanStatus {
  state: "missing" | "ok" | "expired" | "unknown";
  /** Whether a Glean server is set (GLEAN_MCP_URL): without it there's no banner. */
  configured: boolean;
  since: string;
  detail?: string;
}

export interface TelegramStatus {
  state: "missing" | "ok" | "ended" | "error";
  /** Whether telegram/api.json exists: without it Telegram is simply not set up, and there's no banner. */
  configured: boolean;
  since: string;
  detail?: string;
  account?: { name: string; username: string | null };
}

export type TelegramStep = { step: "code" | "password"; login_id: string; via_app?: boolean } | { step: "done"; account: { name: string; username: string | null } };

export interface GoogleAccount {
  email: string;
  primary: boolean;
  state: "unknown" | "ok" | "expired" | "error";
  since: string;
  detail?: string;
}

export interface CommentView {
  id: string;
  body: string;
  author: { kind: "me" | "runner" | "agent" | "user"; name: string };
  createdAt: string;
}

export interface IssueView extends Omit<Card, "scheduled" | "recurring" | "working" | "crew"> {
  working: Working | null;
  description: string;
  bucket: Bucket | null;
  editable: boolean;
  labelIds: string[];
  replyTarget: string;
  scheduled: { date: string; bucket: Bucket; position: "top" | "bottom" } | null;
  recurring: RecurringView | null;
  comments: CommentView[];
  files: FileView[];
  parent: TaskRef | null;
  /** The agents on this task, with each one's latest word (D-45). */
  crew: (CrewMember & { said: { text: string; at: string } | null })[];
}

/** A file on a task (D-43). */
export interface FileView {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
  by: "me" | "agent";
  /** Set on a PDF's text version, which isn't listed separately. */
  textOf: string | null;
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
