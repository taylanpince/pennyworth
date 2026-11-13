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
  kind: "me" | "assistant" | "agent" | "engineer";
  name: string;
  /** What the crew member takes on, in one line (D-60). */
  role?: string;
  /** The role's own engine, and the engines the picker offers (D-60). */
  engine?: Engine;
  engines?: Engine[];
  defaultModel?: string;
  defaultEffort?: string;
  efforts?: string[];
  /** The crew member's name, voice and portrait (D-45). */
  persona?: Persona;
}

export type Engine = "codex" | "claude" | "openrouter";

/** The engine, model and effort a crew member runs a task with, when not its role's own (D-60). */
export interface Executor {
  engine?: Engine;
  model?: string;
  effort?: string;
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
  executor?: Executor;
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

export interface PlanItem {
  text: string;
  state: "todo" | "doing" | "done";
}

export interface Working {
  agent: string;
  since: string | null;
  queued: boolean;
  /** What the agent last said while working, and its own task list (runner jobs). */
  said?: string;
  saidAt?: string;
  plan?: PlanItem[];
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
  saidAt?: string;
  plan?: PlanItem[];
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
  /** Slack host → the ID its slack:// links need. */
  slackTeams: Record<string, string>;
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
  glean: SignInStatus | null;
  /** Grafana sign-in, for the Engineers; null when the board can't ask. */
  grafana: SignInStatus | null;
  /** ClickHouse sign-in, for the Engineers (D-57); null when the board can't ask. */
  clickhouse: SignInStatus | null;
  /** The off-machine backup of tasks and board (D-58); null when the board can't tell. */
  backup: BackupStatus | null;
}

export interface BackupStatus {
  state: "ok" | "failed" | "missing" | "never";
  lastSuccess: string | null;
  error?: string;
  /** No off-machine backup in the last 26 hours. */
  stale: boolean;
}

/** A sign-in through an MCP proxy (Glean, Grafana, ClickHouse). */
export interface SignInStatus {
  state: "missing" | "ok" | "expired" | "unknown";
  /** Whether the service is set up (GLEAN_MCP_URL, GRAFANA_URL, CLICKHOUSE_MCP_URL): without it there's no banner. */
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
  /** After a reply: the agent's part a message that @-mentioned them went to, instead of this chat (D-54). */
  movedTo?: string;
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
  engine: Engine;
  default: string | null;
  defaultEffort: string | null;
  models: string[];
  efforts: string[];
}

export interface Update {
  title?: string;
  description?: string;
  status?: "todo" | "in_progress" | "done" | "cancelled";
  priority?: "critical" | "high" | "medium" | "low";
  assignee?: string;
  engine?: Engine;
  model?: string;
  effort?: string;
  labelIds?: string[];
}

// ---------------------------------------------------------------- memory (D-61)

export type MemoryKind = "rule" | "fact" | "lesson" | "playbook";
export type MemoryStatus = "active" | "proposed" | "rejected" | "archived";

export interface Memory {
  id: number;
  scope: string;
  kind: MemoryKind;
  text: string;
  status: MemoryStatus;
  pinned: boolean;
  sensitive: boolean;
  origin: "remember" | "proposal" | "board";
  createdBy: string | null;
  why: string | null;
  sourceIssue: string | null;
  sourceComment: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  lastUsedAt: string | null;
  uses: number;
}

/** "global" (everyone) or a crew member's scope, with its portrait. */
export interface MemoryScope {
  scope: string;
  name: string;
  avatar: string | null;
  agentId: string | null;
}

export interface MemoryBudget {
  used: number;
  budget: number;
  included: number[];
  omitted: number[];
}

export interface MemoryList {
  memories: Memory[];
  scopes: MemoryScope[];
  budgets: Record<string, MemoryBudget>;
  pending: number;
}

export interface Episode {
  issueId: string;
  identifier: string;
  title: string;
  scope: string;
  summary: string;
  links: string[];
  closedAt: string;
}

export interface MemoryPatch {
  text?: string;
  kind?: MemoryKind;
  scope?: string;
  pinned?: boolean;
  sensitive?: boolean;
  status?: MemoryStatus;
}

// ------------------------------------------------------------- stats (D-62)

export type StatsRange = "7d" | "30d" | "90d";
export interface StatsDelta {
  cur: number;
  prev: number;
}
export interface TokenSeries {
  key: string;
  name: string;
  uncached: number[];
  cached: number[];
  output: number[];
  total: number;
}

/** GET /api/stats: everything the Stats view shows, computed on the board (statsmath.ts). */
export interface Stats {
  range: StatsRange;
  granularity: "day" | "week";
  generatedAt: string;
  period: { from: string; to: string; prevFrom: string; prevTo: string };
  coverage: { runsSyncedAt: string | null; tasksSyncedAt: string | null; jobsReportedAt: string | null; runsSince: string | null; jobsSince: string | null; hasJobs: boolean };
  headline: {
    tokens: StatsDelta;
    cachedShare: StatsDelta;
    costUsd: StatsDelta;
    unpricedJobs: number;
    runs: StatsDelta;
    jobs: StatsDelta;
    tasksCreated: StatsDelta;
    tasksClosed: StatsDelta;
    proposalsWaiting: number;
  };
  tokensDaily: {
    days: string[];
    groups: TokenSeries[];
    agents: { agentId: string | null; name: string; group: string; uncached: number; cached: number; output: number; runs: number; jobs: number; total: number }[];
  };
  modelPreference: {
    executors: string[];
    buckets: string[];
    shares: { bucket: string; counts: Record<string, number> }[];
    roles: { agentId: string | null; name: string; avatar: string | null; defaultExecutor: string | null; jobs: number; executors: { key: string; jobs: number }[]; tasks: number; nonDefaultJobs: number; nonDefaultTasks: number }[];
  };
  roles: {
    agentId: string;
    name: string;
    avatar: string | null;
    kind: "runner" | "paperclip";
    tasks: number;
    jobs: number;
    jobsPerTask: number | null;
    medianMinutes: number | null;
    costUsd: number | null;
    costPerTask: number | null;
    medianContext: number | null;
    maxContext: number | null;
    restarted: number | null;
    retries: number | null;
    tokens: number;
  }[];
  topTasks: { identifier: string; parent: string | null; title: string | null; costUsd: number; jobs: number; peakContext: number; agent: string | null; avatar: string | null }[];
  taskFlow: {
    buckets: string[];
    sources: string[];
    created: { bucket: string; bySource: Record<string, number | undefined> }[];
    closed: number[];
    timeToClose: { source: string; created: number; done: number; medianHours: number | null; p90Hours: number | null }[];
    scoutYield: { agentId: string; name: string; runs: number; tasks: number; perHundredRuns: number | null }[];
  };
  reliability: {
    agents: { agentId: string; name: string; avatar: string | null; runs: number; failed: number; cancelled: number; rate: number; errors: { label: string; count: number }[] }[];
    runs: { total: number; failed: number; cancelled: number; retried: number };
    topErrors: { label: string; count: number }[];
    runner: { jobs: number; finished: number; failed: number; cancelled: number; rate: number; byStatus: Record<string, number>; retries: number; retryShare: number };
  };
  tools: { buckets: string[]; mcp: { server: string; total: number; jobs: number; counts: number[] }[]; builtin: { tool: string; count: number }[] };
  memory: {
    proposed: StatsDelta;
    accepted: StatsDelta;
    rejected: StatsDelta;
    remembered: StatsDelta;
    waiting: number;
    stale: number;
    scopes: { scope: string; name: string; avatar: string | null; active: number; proposals: number; used: number; budget: number; omitted: number }[];
  };
}

export interface Sparklines {
  weeks: string[];
  agents: Record<string, number[]>;
}
