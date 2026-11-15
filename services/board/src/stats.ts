// Stats (D-62): what the agents cost and do, kept in the board's SQLite (so the hourly backup has it,
// D-58). Three sources: the runner's per-job usage (it posts each job to the internal API), Paperclip's
// agent runs (synced every 5 minutes, statssync.ts), and a fact row per task (synced hourly). Memory
// is already here (memory.ts). This file is the tables, the report schema and how a task's source is
// read; the numbers are computed in statsmath.ts, the routes are statsapi.ts.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type { Agent, Issue } from "./paperclip.js";

const UUID = /^[0-9a-f-]{36}$/;
const IDENT = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;
export const JOB_ENGINES = ["codex", "claude", "openrouter"] as const;

const Iso = z
  .string()
  .max(40)
  .refine((s) => Number.isFinite(Date.parse(s)), "an ISO date");
const Tokens = z.number().int().min(0).max(1e12);
const Small = z.number().int().min(0).max(1e7);
/** Tool or MCP server name → calls in the job. */
const Tally = z.record(z.string().min(1).max(120), Small).refine((r) => Object.keys(r).length <= 200, "at most 200 names");

/** One runner job's usage, as the runner reports it (POST /internal/runner/usage). */
export const JobUsageSchema = z
  .object({
    id: z.number().int().min(1).max(2 ** 31),
    issueId: z.string().regex(UUID),
    identifier: z.string().regex(IDENT),
    agentId: z.string().regex(UUID).nullable(),
    engine: z.enum(JOB_ENGINES),
    engineLabel: z.string().max(200),
    model: z.string().max(200).nullable(),
    effort: z.string().max(40).nullable(),
    status: z.string().max(40),
    startedAt: Iso,
    finishedAt: Iso.nullable(),
    resumed: z.boolean(),
    restarted: z.boolean(),
    retry: z.boolean(),
    inputTokens: Tokens,
    cacheReadTokens: Tokens,
    cacheWriteTokens: Tokens,
    outputTokens: Tokens,
    reasoningTokens: Tokens,
    costUsd: z.number().min(0).max(1e6).nullable(),
    contextTokens: Tokens,
    turns: Small,
    subagents: Small,
    tools: Tally,
    mcp: Tally,
  })
  .strict();
export type JobUsage = z.infer<typeof JobUsageSchema>;
export const UsageReportSchema = z.object({ jobs: z.array(JobUsageSchema).max(200) }).strict();

/** A Paperclip agent run, as kept (the fields the stats use; the error's first line only). */
export interface RunRow {
  id: string;
  agentId: string;
  issueId: string | null;
  status: string;
  invocationSource: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  error: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  model: string | null;
  costStatus: string | null;
  billingType: string | null;
  /** Paperclip retried an earlier run (retryOfRunId). */
  retry: boolean;
}

/** heartbeat-runs as Paperclip returns them (only what we read). */
export interface RawRun {
  id: string;
  agentId: string;
  status: string;
  invocationSource?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  errorCode?: string | null;
  error?: unknown;
  contextSnapshot?: { issueId?: string | null } | null;
  usageJson?: { inputTokens?: unknown; cachedInputTokens?: unknown; outputTokens?: unknown; model?: unknown; costStatus?: unknown; billingType?: unknown } | null;
  retryOfRunId?: string | null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const str = (v: unknown, max = 100) => (typeof v === "string" && v ? v.slice(0, max) : null);

export function runFromApi(r: RawRun): RunRow {
  const u = r.usageJson ?? {};
  const err = r.error == null ? null : String(r.error).split("\n")[0]!.trim().slice(0, 200) || null;
  return {
    id: r.id,
    agentId: r.agentId,
    issueId: r.contextSnapshot?.issueId ?? null,
    status: r.status,
    invocationSource: str(r.invocationSource, 40),
    createdAt: r.createdAt,
    startedAt: r.startedAt ?? null,
    finishedAt: r.finishedAt ?? null,
    errorCode: str(r.errorCode, 60),
    error: err,
    inputTokens: num(u.inputTokens),
    cachedInputTokens: num(u.cachedInputTokens),
    outputTokens: num(u.outputTokens),
    model: str(u.model),
    costStatus: str(u.costStatus, 40),
    billingType: str(u.billingType, 40),
    retry: !!r.retryOfRunId,
  };
}

/** A Paperclip run still going: it's fetched again until it finishes. */
export const runFinished = (r: Pick<RunRow, "status" | "finishedAt">) => !!r.finishedAt || !["queued", "running"].includes(r.status);

/** Where a task came from (taskFlow): the scouts' and the board's markers, else who made it. */
export const SOURCES = ["meeting", "slack", "slack-pin", "telegram", "gmail", "primer", "github", "brief", "recurring", "you", "crew", "agent", "other"] as const;
export type Source = (typeof SOURCES)[number];

/** The scout (setup key) that brings a source's tasks in. */
export const SCOUT_SOURCES: Record<string, Source[]> = {
  "pennyworth:slack-scout": ["slack", "slack-pin"],
  "pennyworth:telegram-scout": ["telegram"],
  "pennyworth:inbox-agent": ["gmail"],
  "pennyworth:meeting-librarian": ["meeting"],
};

/**
 * A task's source from its own marker (`<!-- source:… -->`, the first one: a merged duplicate's is
 * `merged-source:`, D-56). Scouts write `source:source:<platform>:…` (Slack pins `…:slack:pin:…`),
 * meetings `source:meeting:…` and their review tasks `source:review:…`, the brief `source:brief:<date>`,
 * GitHub issues `source:source:github:…`, recurring outputs `source:recurring:…`, D-24 sub-tasks
 * `source:subtask:…`. Undefined when there's no marker.
 */
export function markerSource(description: string | null | undefined): Source | undefined {
  const m = /<!--\s*source:(?:source:)*([a-z][a-z-]*)(?::([a-z]+))?/.exec(description ?? "");
  if (!m) return undefined;
  switch (m[1]) {
    case "slack":
      return m[2] === "pin" ? "slack-pin" : "slack";
    case "telegram":
    case "gmail":
    case "meeting":
    case "primer":
    case "recurring":
    case "brief":
    case "github":
      return m[1];
    case "review":
      return "meeting";
    case "subtask":
      return "crew";
    case "blocker":
      return "agent";
    default:
      return "other";
  }
}

export interface TaskFact {
  id: string;
  identifier: string;
  title: string;
  parentId: string | null;
  status: string;
  createdAt: string;
  closedAt: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  labels: string[];
  source: Source;
  /** A crew member's part of a task (D-45): parent set, assigned to an agent with a persona. */
  part: boolean;
}

/** A task's facts; `crew` tells an agent with a persona (D-45: a sub-task assigned to one is a crew part). */
export function factFromIssue(i: Issue, agents: Agent[], crew: (a: Agent) => boolean): TaskFact {
  const byId = (id: string | null | undefined) => (id ? agents.find((a) => a.id === id) : undefined);
  const labels = (i.labels ?? []).map((l) => l.name).slice(0, 20);
  const assignee = byId(i.assigneeAgentId);
  const part = !!i.parentId && !!assignee && crew(assignee);
  const by = byId(i.createdByAgentId)?.metadata?.setupKey ?? "";
  let source = markerSource(i.description);
  if (!source) {
    if (labels.includes("daily-brief") || by === "pennyworth:chief-of-staff") source = "brief";
    else if (part) source = "crew";
    else if (SCOUT_SOURCES[by]) source = SCOUT_SOURCES[by]![0]!;
    else if (i.createdByAgentId) source = "agent";
    else source = "you";
  }
  const closed = i.status === "done" || i.status === "cancelled";
  return {
    id: i.id,
    identifier: i.identifier,
    title: (i.title ?? "").slice(0, 300),
    parentId: i.parentId ?? null,
    status: i.status,
    createdAt: i.createdAt,
    closedAt: closed ? (i.completedAt ?? i.cancelledAt ?? i.updatedAt) : null,
    assigneeAgentId: i.assigneeAgentId ?? null,
    assigneeUserId: i.assigneeUserId ?? null,
    createdByAgentId: i.createdByAgentId ?? null,
    createdByUserId: i.createdByUserId ?? null,
    labels,
    source,
    part,
  };
}

export interface JobRow extends JobUsage {
  updatedAt: string;
}

interface JobDbRow {
  id: number;
  issue_id: string;
  identifier: string;
  agent_id: string | null;
  engine: string;
  engine_label: string;
  model: string | null;
  effort: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  resumed: number;
  restarted: number;
  retry: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
  context_tokens: number;
  turns: number;
  subagents: number;
  tools: string;
  mcp: string;
  updated_at: string;
}

const toJob = (r: JobDbRow): JobRow => ({
  id: r.id,
  issueId: r.issue_id,
  identifier: r.identifier,
  agentId: r.agent_id,
  engine: r.engine as JobUsage["engine"],
  engineLabel: r.engine_label,
  model: r.model,
  effort: r.effort,
  status: r.status,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  resumed: r.resumed === 1,
  restarted: r.restarted === 1,
  retry: r.retry === 1,
  inputTokens: r.input_tokens,
  cacheReadTokens: r.cache_read_tokens,
  cacheWriteTokens: r.cache_write_tokens,
  outputTokens: r.output_tokens,
  reasoningTokens: r.reasoning_tokens,
  costUsd: r.cost_usd,
  contextTokens: r.context_tokens,
  turns: r.turns,
  subagents: r.subagents,
  tools: JSON.parse(r.tools) as Record<string, number>,
  mcp: JSON.parse(r.mcp) as Record<string, number>,
  updatedAt: r.updated_at,
});

interface RunDbRow {
  id: string;
  agent_id: string;
  issue_id: string | null;
  status: string;
  invocation_source: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  model: string | null;
  cost_status: string | null;
  billing_type: string | null;
  retry: number;
}

const toRun = (r: RunDbRow): RunRow => ({
  id: r.id,
  agentId: r.agent_id,
  issueId: r.issue_id,
  status: r.status,
  invocationSource: r.invocation_source,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  errorCode: r.error_code,
  error: r.error,
  inputTokens: r.input_tokens,
  cachedInputTokens: r.cached_input_tokens,
  outputTokens: r.output_tokens,
  model: r.model,
  costStatus: r.cost_status,
  billingType: r.billing_type,
  retry: r.retry === 1,
});

interface TaskDbRow {
  id: string;
  identifier: string;
  title: string;
  parent_id: string | null;
  status: string;
  created_at: string;
  closed_at: string | null;
  assignee_agent_id: string | null;
  assignee_user_id: string | null;
  created_by_agent_id: string | null;
  created_by_user_id: string | null;
  labels: string;
  source: string;
  part: number;
}

const toTask = (r: TaskDbRow): TaskFact => ({
  id: r.id,
  identifier: r.identifier,
  title: r.title,
  parentId: r.parent_id,
  status: r.status,
  createdAt: r.created_at,
  closedAt: r.closed_at,
  assigneeAgentId: r.assignee_agent_id,
  assigneeUserId: r.assignee_user_id,
  createdByAgentId: r.created_by_agent_id,
  createdByUserId: r.created_by_user_id,
  labels: JSON.parse(r.labels) as string[],
  source: r.source as Source,
  part: r.part === 1,
});

export class StatsStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS stats_jobs (
        id INTEGER PRIMARY KEY, issue_id TEXT NOT NULL, identifier TEXT NOT NULL, agent_id TEXT, engine TEXT NOT NULL, engine_label TEXT NOT NULL,
        model TEXT, effort TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        resumed INTEGER NOT NULL, restarted INTEGER NOT NULL, retry INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
        cost_usd REAL, context_tokens INTEGER NOT NULL, turns INTEGER NOT NULL, subagents INTEGER NOT NULL, tools TEXT NOT NULL, mcp TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS stats_jobs_started ON stats_jobs (started_at);
      CREATE TABLE IF NOT EXISTS stats_runs (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, issue_id TEXT, status TEXT NOT NULL, invocation_source TEXT,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error_code TEXT, error TEXT,
        input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        model TEXT, cost_status TEXT, billing_type TEXT, retry INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS stats_runs_created ON stats_runs (created_at);
      CREATE TABLE IF NOT EXISTS stats_tasks (
        id TEXT PRIMARY KEY, identifier TEXT NOT NULL, title TEXT NOT NULL, parent_id TEXT, status TEXT NOT NULL,
        created_at TEXT NOT NULL, closed_at TEXT, assignee_agent_id TEXT, assignee_user_id TEXT,
        created_by_agent_id TEXT, created_by_user_id TEXT, labels TEXT NOT NULL, source TEXT NOT NULL, part INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS stats_tasks_created ON stats_tasks (created_at);
    `);
  }

  private tx(fn: () => void) {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(`stats:${key}`) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`stats:${key}`, value);
  }

  // ------------------------------------------------------------- runner jobs

  /** Insert or replace each job by its id (the runner reports a job again as it changes). */
  upsertJobs(jobs: JobUsage[]): number {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO stats_jobs (id, issue_id, identifier, agent_id, engine, engine_label, model, effort, status, started_at, finished_at, resumed, restarted, retry,
        input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, cost_usd, context_tokens, turns, subagents, tools, mcp, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET issue_id = excluded.issue_id, identifier = excluded.identifier, agent_id = excluded.agent_id, engine = excluded.engine,
        engine_label = excluded.engine_label, model = excluded.model, effort = excluded.effort, status = excluded.status, started_at = excluded.started_at,
        finished_at = excluded.finished_at, resumed = excluded.resumed, restarted = excluded.restarted, retry = excluded.retry, input_tokens = excluded.input_tokens,
        cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens, output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens, cost_usd = excluded.cost_usd, context_tokens = excluded.context_tokens, turns = excluded.turns,
        subagents = excluded.subagents, tools = excluded.tools, mcp = excluded.mcp, updated_at = excluded.updated_at`,
    );
    this.tx(() => {
      for (const j of jobs) {
        stmt.run(
          j.id, j.issueId, j.identifier, j.agentId, j.engine, j.engineLabel, j.model, j.effort, j.status, j.startedAt, j.finishedAt,
          j.resumed ? 1 : 0, j.restarted ? 1 : 0, j.retry ? 1 : 0, j.inputTokens, j.cacheReadTokens, j.cacheWriteTokens, j.outputTokens, j.reasoningTokens,
          j.costUsd, j.contextTokens, j.turns, j.subagents, JSON.stringify(j.tools), JSON.stringify(j.mcp), now,
        );
      }
    });
    if (jobs.length) this.setMeta("jobs_reported_at", now);
    return jobs.length;
  }

  jobs(since?: string): JobRow[] {
    const rows = since ? this.db.prepare("SELECT * FROM stats_jobs WHERE started_at >= ? ORDER BY started_at").all(since) : this.db.prepare("SELECT * FROM stats_jobs ORDER BY started_at").all();
    return (rows as unknown as JobDbRow[]).map(toJob);
  }

  // ---------------------------------------------------------- Paperclip runs

  upsertRuns(runs: RunRow[]): number {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO stats_runs (id, agent_id, issue_id, status, invocation_source, created_at, started_at, finished_at, error_code, error, input_tokens, cached_input_tokens, output_tokens, model, cost_status, billing_type, retry, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id, issue_id = excluded.issue_id, status = excluded.status, invocation_source = excluded.invocation_source,
        created_at = excluded.created_at, started_at = excluded.started_at, finished_at = excluded.finished_at, error_code = excluded.error_code, error = excluded.error,
        input_tokens = excluded.input_tokens, cached_input_tokens = excluded.cached_input_tokens, output_tokens = excluded.output_tokens, model = excluded.model,
        cost_status = excluded.cost_status, billing_type = excluded.billing_type, retry = excluded.retry, updated_at = excluded.updated_at`,
    );
    this.tx(() => {
      for (const r of runs) {
        stmt.run(r.id, r.agentId, r.issueId, r.status, r.invocationSource, r.createdAt, r.startedAt, r.finishedAt, r.errorCode, r.error, r.inputTokens, r.cachedInputTokens, r.outputTokens, r.model, r.costStatus, r.billingType, r.retry ? 1 : 0, now);
      }
    });
    return runs.length;
  }

  runs(since?: string): RunRow[] {
    const rows = since ? this.db.prepare("SELECT * FROM stats_runs WHERE created_at >= ? ORDER BY created_at").all(since) : this.db.prepare("SELECT * FROM stats_runs ORDER BY created_at").all();
    return (rows as unknown as RunDbRow[]).map(toRun);
  }

  runCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM stats_runs").get() as { n: number }).n;
  }

  /** Which of these runs are already kept as finished (those needn't change again). */
  finishedRunIds(ids: string[]): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.db.prepare(`SELECT id, status, finished_at FROM stats_runs WHERE id IN (${chunk.map(() => "?").join(", ")})`).all(...chunk) as { id: string; status: string; finished_at: string | null }[];
      for (const r of rows) if (runFinished({ status: r.status, finishedAt: r.finished_at })) out.add(r.id);
    }
    return out;
  }

  /** The oldest run still kept as unfinished, created after `since`: the sync goes back to it. */
  oldestUnfinishedRun(since: string): string | undefined {
    return (this.db.prepare("SELECT MIN(created_at) AS at FROM stats_runs WHERE finished_at IS NULL AND status IN ('queued', 'running') AND created_at >= ?").get(since) as { at: string | null }).at ?? undefined;
  }

  // -------------------------------------------------------------- task facts

  upsertTasks(facts: TaskFact[]): number {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO stats_tasks (id, identifier, title, parent_id, status, created_at, closed_at, assignee_agent_id, assignee_user_id, created_by_agent_id, created_by_user_id, labels, source, part, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET identifier = excluded.identifier, title = excluded.title, parent_id = excluded.parent_id, status = excluded.status,
        created_at = excluded.created_at, closed_at = excluded.closed_at, assignee_agent_id = excluded.assignee_agent_id, assignee_user_id = excluded.assignee_user_id,
        created_by_agent_id = excluded.created_by_agent_id, created_by_user_id = excluded.created_by_user_id, labels = excluded.labels, source = excluded.source,
        part = excluded.part, updated_at = excluded.updated_at`,
    );
    this.tx(() => {
      for (const t of facts) {
        stmt.run(t.id, t.identifier, t.title, t.parentId, t.status, t.createdAt, t.closedAt, t.assigneeAgentId, t.assigneeUserId, t.createdByAgentId, t.createdByUserId, JSON.stringify(t.labels), t.source, t.part ? 1 : 0, now);
      }
    });
    return facts.length;
  }

  tasks(): TaskFact[] {
    return (this.db.prepare("SELECT * FROM stats_tasks ORDER BY created_at").all() as unknown as TaskDbRow[]).map(toTask);
  }

  /** The source already worked out for these tasks (a marker cut off a list's truncated description is fetched once). */
  knownSources(ids: string[]): Map<string, Source> {
    const out = new Map<string, Source>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.db.prepare(`SELECT id, source FROM stats_tasks WHERE id IN (${chunk.map(() => "?").join(", ")})`).all(...(chunk as SQLInputValue[])) as { id: string; source: string }[];
      for (const r of rows) out.set(r.id, r.source as Source);
    }
    return out;
  }

  taskCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM stats_tasks").get() as { n: number }).n;
  }
}
