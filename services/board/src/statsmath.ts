// The Stats view's numbers (D-62), computed in code from the kept rows: pure functions, unit-tested.
// Days are the user's local days; a range is the last N of them up to today, compared with the N before.
import { isRole, personaOf, roleEngine } from "./board.js";
import { GLOBAL, type Budget, type Memory } from "./memory.js";
import type { Agent } from "./paperclip.js";
import { SCOUT_SOURCES, SOURCES, type JobRow, type RunRow, type Source, type TaskFact } from "./stats.js";

export const RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const;
export type RangeKey = keyof typeof RANGES;

// ------------------------------------------------------------------ days

const formatters = new Map<string, Intl.DateTimeFormat>();
/** The local calendar day (YYYY-MM-DD) of a timestamp in a timezone. */
export function dayOf(iso: string, tz: string): string {
  let f = formatters.get(tz);
  if (!f) formatters.set(tz, (f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })));
  return f.format(new Date(iso));
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The Monday of a day's week. */
export function weekOf(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

export interface Period {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  days: string[];
}

export function periodOf(range: RangeKey, now: number, tz: string): Period {
  const n = RANGES[range];
  const to = dayOf(new Date(now).toISOString(), tz);
  const from = addDays(to, -(n - 1));
  const days = Array.from({ length: n }, (_, i) => addDays(from, i));
  return { from, to, prevFrom: addDays(from, -n), prevTo: addDays(from, -1), days };
}

const within = (day: string, from: string, to: string) => day >= from && day <= to;

export function median(xs: number[]): number | null {
  return quantile(xs, 0.5);
}

export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round = (x: number, digits = 2) => Math.round(x * 10 ** digits) / 10 ** digits;

// ---------------------------------------------------------------- agents

/** Groups for the token chart: one fixed colour each, by setup key (never by rank). */
export const TOKEN_GROUPS = [
  { key: "assistant", name: "Alfred", setupKeys: ["pennyworth:assistant"] },
  { key: "writer", name: "Ursula", setupKeys: ["pennyworth:writer"] },
  { key: "engineers", name: "Engineers", setupKeys: [] as string[] },
  { key: "slack", name: "Slack Scout", setupKeys: ["pennyworth:slack-scout"] },
  { key: "telegram", name: "Telegram Scout", setupKeys: ["pennyworth:telegram-scout"] },
  { key: "meetings", name: "Meeting Librarian", setupKeys: ["pennyworth:meeting-librarian"] },
  { key: "brief", name: "Brief & inbox", setupKeys: ["pennyworth:chief-of-staff", "pennyworth:inbox-agent"] },
  { key: "other", name: "Other", setupKeys: [] as string[] },
] as const;
export type TokenGroup = (typeof TOKEN_GROUPS)[number]["key"];

// Crew in the order the board offers them, then the background agents.
const ORDER = ["pennyworth:assistant", "pennyworth:writer", "pennyworth:engineer-claude", "pennyworth:reviewer", "pennyworth:security", "pennyworth:sre", "pennyworth:slack-scout", "pennyworth:telegram-scout", "pennyworth:meeting-librarian", "pennyworth:chief-of-staff", "pennyworth:inbox-agent"];

export interface AgentInfo {
  id: string;
  /** The persona's name for the crew (D-45), else Paperclip's. */
  name: string;
  avatar: string | null;
  setupKey: string;
  crew: boolean;
  /** One of the runner's roles (D-60): its work is runner jobs. */
  runner: boolean;
  /** The role's own engine and model (metadata.role): what "default executor" means. */
  role: { engine: string; model: string | null } | null;
  group: TokenGroup;
}

export function agentInfos(agents: Agent[]): AgentInfo[] {
  const out = agents.map((a): AgentInfo => {
    const persona = personaOf(a);
    const setupKey = a.metadata?.setupKey ?? "";
    const runner = isRole(a);
    const own = runner ? roleEngine(a) : undefined;
    const group = runner ? "engineers" : (TOKEN_GROUPS.find((g) => (g.setupKeys as readonly string[]).includes(setupKey))?.key ?? "other");
    return { id: a.id, name: persona?.name ?? a.name, avatar: persona?.avatar ?? null, setupKey, crew: !!persona, runner, role: own ? { engine: own.engine, model: own.model ?? null } : null, group };
  });
  const rank = (a: AgentInfo) => (ORDER.includes(a.setupKey) ? ORDER.indexOf(a.setupKey) : ORDER.length);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- tokens

/** A Paperclip run's tokens: Paperclip counts cached input inside `inputTokens`. */
export const runTokens = (r: RunRow) => ({ uncached: Math.max(0, r.inputTokens - r.cachedInputTokens), cached: Math.min(r.cachedInputTokens, r.inputTokens), output: r.outputTokens });
/** A runner job's tokens: input, cache reads and cache writes are separate counts (cache writes are uncached input). */
export const jobTokens = (j: JobRow) => ({ uncached: j.inputTokens + j.cacheWriteTokens, cached: j.cacheReadTokens, output: j.outputTokens });
const total = (t: { uncached: number; cached: number; output: number }) => t.uncached + t.cached + t.output;

// ------------------------------------------------------------- statuses

/** Paperclip run statuses that count as a failure (cancelled is counted on its own). */
const RUN_FAILED = new Set(["failed", "timed_out", "error"]);
/** Runner job statuses (services/runner: finishJob) that count as a failure. */
const JOB_FAILED = new Set(["failed", "timeout", "interrupted", "incomplete"]);

/** Error lines folded into the causes the user knows. */
const ERRORS: [RegExp, string][] = [
  [/cloud config bundle/i, "Codex cloud config timed out"],
  [/at capacity/i, "Model at capacity"],
  [/invalid_grant|refresh_token|refresh token/i, "Sign-in expired (invalid_grant)"],
  [/skip-git-repo-check|trusted directory/i, "Not in a trusted directory"],
  [/invalid transport/i, "Invalid MCP transport"],
  [/workspace routing/i, "Workspace routing failed"],
  [/process lost/i, "Process lost"],
  [/reassign/i, "Cancelled: task reassigned"],
  [/quota|rate.?limit|\b429\b/i, "Quota or rate limit"],
  [/timed? ?out|timeout/i, "Timed out"],
  [/cancel/i, "Cancelled"],
];

export function errorLabel(r: Pick<RunRow, "error" | "errorCode" | "status">): string {
  const text = `${r.error ?? ""} ${r.errorCode ?? ""}`;
  for (const [re, label] of ERRORS) if (re.test(text)) return label;
  if (r.error) return r.error.replace(/^Error:\s*/, "").replace(/\d+/g, "#").slice(0, 80);
  return r.errorCode ?? r.status;
}

// ------------------------------------------------------------- executors

const normModel = (m: string) => m.toLowerCase().replace(/^(openrouter|anthropic|openai)\//, "").replace(/\[.*\]$/, "");
const ENGINE_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", openrouter: "OpenRouter" };

/** "Claude Code · claude-opus-5-5", "Codex · Codex default". */
export function executorKey(engine: string, model: string | null): string {
  return `${ENGINE_NAMES[engine] ?? engine} · ${model || (engine === "codex" ? "Codex default" : "default")}`;
}

/** Whether a job ran on something else than its role's own engine and model (the task's executor override, D-60). */
export function nonDefault(job: Pick<JobRow, "engine" | "model">, role: AgentInfo["role"]): boolean {
  if (!role) return false;
  if (job.engine !== role.engine) return true;
  return !!(job.model && role.model && normModel(job.model) !== normModel(role.model) && !normModel(job.model).includes(normModel(role.model)) && !normModel(role.model).includes(normModel(job.model)));
}

// ------------------------------------------------------------------ input

export interface StatsInput {
  range: RangeKey;
  now: number;
  tz: string;
  agents: AgentInfo[];
  jobs: JobRow[];
  runs: RunRow[];
  tasks: TaskFact[];
  memories: Memory[];
  budgets: Record<string, Budget>;
  /** Memory scopes as the Memory view names them. */
  scopes: { scope: string; name: string; avatar: string | null }[];
  coverage: { runsSyncedAt: string | null; tasksSyncedAt: string | null; jobsReportedAt: string | null };
}

export interface Delta {
  cur: number;
  prev: number;
}

const STALE_MS = 30 * 86_400_000;

export function computeStats(input: StatsInput) {
  const { tz, agents } = input;
  const p = periodOf(input.range, input.now, tz);
  const granularity: "day" | "week" = input.range === "7d" ? "day" : "week";
  const bucketOf = (day: string) => (granularity === "day" ? day : weekOf(day));
  const buckets = [...new Set(p.days.map(bucketOf))];
  const agentOf = new Map(agents.map((a) => [a.id, a]));
  const taskById = new Map(input.tasks.map((t) => [t.id, t]));
  const nameOf = (id: string | null) => (id ? (agentOf.get(id)?.name ?? "Unknown agent") : "Unknown");

  // Days once per row.
  const runs = input.runs.map((r) => ({ r, day: dayOf(r.createdAt, tz) }));
  const jobs = input.jobs.map((j) => ({ j, day: dayOf(j.startedAt, tz), agentId: j.agentId ?? taskById.get(j.issueId)?.assigneeAgentId ?? null }));
  const cur = { runs: runs.filter((x) => within(x.day, p.from, p.to)), jobs: jobs.filter((x) => within(x.day, p.from, p.to)) };
  const prev = { runs: runs.filter((x) => within(x.day, p.prevFrom, p.prevTo)), jobs: jobs.filter((x) => within(x.day, p.prevFrom, p.prevTo)) };
  const userTasks = input.tasks.filter((t) => !t.part);
  const createdIn = (from: string, to: string) => userTasks.filter((t) => within(dayOf(t.createdAt, tz), from, to));
  const closedIn = (from: string, to: string) => userTasks.filter((t) => t.closedAt && within(dayOf(t.closedAt, tz), from, to));

  // ---------------------------------------------------------- headline
  const tokensOf = (s: typeof cur) => sum(s.runs.map((x) => total(runTokens(x.r)))) + sum(s.jobs.map((x) => total(jobTokens(x.j))));
  const cachedOf = (s: typeof cur) => sum(s.runs.map((x) => runTokens(x.r).cached)) + sum(s.jobs.map((x) => jobTokens(x.j).cached));
  const inputOf = (s: typeof cur) => sum(s.runs.map((x) => x.r.inputTokens)) + sum(s.jobs.map((x) => x.j.inputTokens + x.j.cacheReadTokens + x.j.cacheWriteTokens));
  const costOf = (s: typeof cur) => round(sum(s.jobs.map((x) => x.j.costUsd ?? 0)));
  const headline = {
    tokens: { cur: tokensOf(cur), prev: tokensOf(prev) },
    cachedShare: { cur: round(cachedOf(cur) / (inputOf(cur) || 1), 3), prev: round(cachedOf(prev) / (inputOf(prev) || 1), 3) },
    costUsd: { cur: costOf(cur), prev: costOf(prev) },
    unpricedJobs: cur.jobs.filter((x) => x.j.costUsd === null).length,
    runs: { cur: cur.runs.length, prev: prev.runs.length },
    jobs: { cur: cur.jobs.length, prev: prev.jobs.length },
    tasksCreated: { cur: createdIn(p.from, p.to).length, prev: createdIn(p.prevFrom, p.prevTo).length },
    tasksClosed: { cur: closedIn(p.from, p.to).length, prev: closedIn(p.prevFrom, p.prevTo).length },
    proposalsWaiting: input.memories.filter((m) => m.status === "proposed").length,
  };

  // ------------------------------------------------------ tokens daily
  const dayIndex = new Map(p.days.map((d, i) => [d, i]));
  const zeros = () => p.days.map(() => 0);
  const groups = new Map(TOKEN_GROUPS.map((g) => [g.key as TokenGroup, { key: g.key as TokenGroup, name: g.name, uncached: zeros(), cached: zeros(), output: zeros(), total: 0 }]));
  const perAgent = new Map<string, { agentId: string | null; name: string; group: TokenGroup; uncached: number; cached: number; output: number; runs: number; jobs: number }>();
  const addTokens = (agentId: string | null, day: string, t: { uncached: number; cached: number; output: number }, kind: "run" | "job") => {
    const i = dayIndex.get(day)!;
    const info = agentId ? agentOf.get(agentId) : undefined;
    const g = groups.get(info?.group ?? (kind === "job" ? "engineers" : "other"))!;
    g.uncached[i]! += t.uncached;
    g.cached[i]! += t.cached;
    g.output[i]! += t.output;
    g.total += total(t);
    const key = agentId ?? `unknown:${kind}`;
    const a = perAgent.get(key) ?? { agentId, name: agentId ? nameOf(agentId) : kind === "job" ? "Engineer (unknown role)" : "Unknown agent", group: g.key, uncached: 0, cached: 0, output: 0, runs: 0, jobs: 0 };
    a.uncached += t.uncached;
    a.cached += t.cached;
    a.output += t.output;
    if (kind === "run") a.runs++;
    else a.jobs++;
    perAgent.set(key, a);
  };
  for (const x of cur.runs) addTokens(x.r.agentId, x.day, runTokens(x.r), "run");
  for (const x of cur.jobs) addTokens(x.agentId, x.day, jobTokens(x.j), "job");
  const tokensDaily = {
    days: p.days,
    groups: [...groups.values()].filter((g) => g.total > 0 || g.key !== "other"),
    agents: [...perAgent.values()].map((a) => ({ ...a, total: a.uncached + a.cached + a.output })).sort((a, b) => b.total - a.total),
  };

  // --------------------------------------------------- model preference
  const runnerRoles = agents.filter((a) => a.runner);
  const executorsSeen = new Map<string, number>();
  for (const x of cur.jobs) executorsSeen.set(executorKey(x.j.engine, x.j.model), (executorsSeen.get(executorKey(x.j.engine, x.j.model)) ?? 0) + 1);
  const executors = [...executorsSeen.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const modelPreference = {
    executors,
    buckets,
    shares: buckets.map((b) => {
      const counts: Record<string, number> = {};
      for (const x of cur.jobs) if (bucketOf(x.day) === b) counts[executorKey(x.j.engine, x.j.model)] = (counts[executorKey(x.j.engine, x.j.model)] ?? 0) + 1;
      return { bucket: b, counts };
    }),
    roles: [...runnerRoles, ...(cur.jobs.some((x) => !x.agentId || !agentOf.get(x.agentId)?.runner) ? [null] : [])].map((role) => {
      const mine = cur.jobs.filter((x) => (role ? x.agentId === role.id : !x.agentId || !agentOf.get(x.agentId)?.runner));
      const byExec: Record<string, number> = {};
      for (const x of mine) byExec[executorKey(x.j.engine, x.j.model)] = (byExec[executorKey(x.j.engine, x.j.model)] ?? 0) + 1;
      const tasks = new Set(mine.map((x) => x.j.issueId));
      const off = mine.filter((x) => nonDefault(x.j, role?.role ?? null));
      return {
        agentId: role?.id ?? null,
        name: role?.name ?? "Unknown role",
        avatar: role?.avatar ?? null,
        defaultExecutor: role?.role ? executorKey(role.role.engine, role.role.model) : null,
        jobs: mine.length,
        executors: Object.entries(byExec).sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, jobs: n })),
        tasks: tasks.size,
        nonDefaultJobs: off.length,
        nonDefaultTasks: new Set(off.map((x) => x.j.issueId)).size,
      };
    }),
  };

  // ------------------------------------------------------------- roles
  const minutes = (a: string | null, b: string | null) => (a && b ? (Date.parse(b) - Date.parse(a)) / 60_000 : null);
  const roles = agents
    .filter((a) => a.crew)
    .map((a) => {
      if (a.runner) {
        const mine = cur.jobs.filter((x) => x.agentId === a.id).map((x) => x.j);
        const tasks = new Set(mine.map((j) => j.issueId)).size;
        const cost = sum(mine.map((j) => j.costUsd ?? 0));
        const ctx = mine.map((j) => j.contextTokens).filter((n) => n > 0);
        return {
          agentId: a.id,
          name: a.name,
          avatar: a.avatar,
          kind: "runner" as const,
          tasks,
          jobs: mine.length,
          jobsPerTask: tasks ? round(mine.length / tasks, 1) : null,
          medianMinutes: round(median(mine.map((j) => minutes(j.startedAt, j.finishedAt)).filter((m): m is number => m !== null)) ?? NaN, 1),
          costUsd: round(cost),
          costPerTask: tasks ? round(cost / tasks) : null,
          medianContext: median(ctx),
          maxContext: ctx.length ? Math.max(...ctx) : null,
          restarted: mine.filter((j) => j.restarted).length,
          retries: mine.filter((j) => j.retry).length,
          tokens: sum(mine.map((j) => total(jobTokens(j)))),
        };
      }
      const mine = cur.runs.filter((x) => x.r.agentId === a.id).map((x) => x.r);
      const tasks = new Set(mine.map((r) => r.issueId).filter(Boolean)).size;
      return {
        agentId: a.id,
        name: a.name,
        avatar: a.avatar,
        kind: "paperclip" as const,
        tasks,
        jobs: mine.length,
        jobsPerTask: tasks ? round(mine.length / tasks, 1) : null,
        medianMinutes: round(median(mine.map((r) => minutes(r.startedAt, r.finishedAt)).filter((m): m is number => m !== null)) ?? NaN, 1),
        costUsd: null,
        costPerTask: null,
        medianContext: null,
        maxContext: null,
        restarted: null,
        retries: null,
        tokens: sum(mine.map((r) => total(runTokens(r)))),
      };
    })
    .map((r) => ({ ...r, medianMinutes: Number.isNaN(r.medianMinutes) ? null : r.medianMinutes }));

  // ------------------------------------------------------- top tasks
  const perTask = new Map<string, { issueId: string; identifier: string; costUsd: number; jobs: number; peakContext: number; agentId: string | null; priced: boolean }>();
  for (const x of cur.jobs) {
    const t = perTask.get(x.j.issueId) ?? { issueId: x.j.issueId, identifier: x.j.identifier, costUsd: 0, jobs: 0, peakContext: 0, agentId: x.agentId, priced: false };
    t.costUsd += x.j.costUsd ?? 0;
    t.priced ||= x.j.costUsd !== null;
    t.jobs++;
    t.peakContext = Math.max(t.peakContext, x.j.contextTokens);
    perTask.set(x.j.issueId, t);
  }
  const topTasks = [...perTask.values()]
    .filter((t) => t.priced)
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 10)
    .map((t) => {
      const fact = taskById.get(t.issueId);
      const parent = fact?.parentId ? taskById.get(fact.parentId) : undefined;
      return { identifier: t.identifier, parent: parent?.identifier ?? null, title: fact?.title ?? null, costUsd: round(t.costUsd), jobs: t.jobs, peakContext: t.peakContext, agent: t.agentId ? nameOf(t.agentId) : null, avatar: t.agentId ? (agentOf.get(t.agentId)?.avatar ?? null) : null };
    });

  // ------------------------------------------------------- task flow
  const created = createdIn(p.from, p.to);
  const sources = SOURCES.filter((s) => created.some((t) => t.source === s));
  const ttc = (list: TaskFact[]) => list.filter((t) => t.closedAt && t.status === "done").map((t) => (Date.parse(t.closedAt!) - Date.parse(t.createdAt)) / 3_600_000);
  const scoutAgents = agents.filter((a) => SCOUT_SOURCES[a.setupKey]);
  const taskFlow = {
    buckets,
    sources,
    created: buckets.map((b) => {
      const bySource: Partial<Record<Source, number>> = {};
      for (const t of created) if (bucketOf(dayOf(t.createdAt, tz)) === b) bySource[t.source] = (bySource[t.source] ?? 0) + 1;
      return { bucket: b, bySource };
    }),
    closed: buckets.map((b) => closedIn(p.from, p.to).filter((t) => bucketOf(dayOf(t.closedAt!, tz)) === b).length),
    timeToClose: sources.map((s) => {
      const hours = ttc(created.filter((t) => t.source === s));
      return { source: s, created: created.filter((t) => t.source === s).length, done: hours.length, medianHours: round(median(hours) ?? NaN, 1), p90Hours: round(quantile(hours, 0.9) ?? NaN, 1) };
    }).map((r) => ({ ...r, medianHours: Number.isNaN(r.medianHours) ? null : r.medianHours, p90Hours: Number.isNaN(r.p90Hours) ? null : r.p90Hours })),
    scoutYield: scoutAgents.map((a) => {
      const n = cur.runs.filter((x) => x.r.agentId === a.id).length;
      const made = created.filter((t) => SCOUT_SOURCES[a.setupKey]!.includes(t.source)).length;
      return { agentId: a.id, name: a.name, runs: n, tasks: made, perHundredRuns: n ? round((made / n) * 100, 1) : null };
    }),
  };

  // ----------------------------------------------------- reliability
  const errorTally = (list: RunRow[]) => {
    const m = new Map<string, number>();
    for (const r of list) m.set(errorLabel(r), (m.get(errorLabel(r)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count }));
  };
  const runAgents = [...new Set(cur.runs.map((x) => x.r.agentId))];
  const jobStatuses: Record<string, number> = {};
  for (const x of cur.jobs) jobStatuses[x.j.status] = (jobStatuses[x.j.status] ?? 0) + 1;
  const finishedJobs = cur.jobs.filter((x) => x.j.status !== "running");
  const failedJobs = finishedJobs.filter((x) => JOB_FAILED.has(x.j.status));
  const retries = cur.jobs.filter((x) => x.j.retry).length;
  const reliability = {
    agents: runAgents
      .map((id) => {
        const mine = cur.runs.filter((x) => x.r.agentId === id).map((x) => x.r);
        const failed = mine.filter((r) => RUN_FAILED.has(r.status));
        const cancelled = mine.filter((r) => r.status === "cancelled");
        return { agentId: id, name: nameOf(id), avatar: agentOf.get(id)?.avatar ?? null, runs: mine.length, failed: failed.length, cancelled: cancelled.length, rate: mine.length ? round(failed.length / mine.length, 3) : 0, errors: errorTally([...failed, ...cancelled]).slice(0, 3) };
      })
      .sort((a, b) => b.failed - a.failed || b.runs - a.runs),
    runs: { total: cur.runs.length, failed: cur.runs.filter((x) => RUN_FAILED.has(x.r.status)).length, cancelled: cur.runs.filter((x) => x.r.status === "cancelled").length, retried: cur.runs.filter((x) => x.r.retry).length },
    topErrors: errorTally(cur.runs.filter((x) => RUN_FAILED.has(x.r.status) || x.r.status === "cancelled").map((x) => x.r)).slice(0, 8),
    runner: { jobs: cur.jobs.length, finished: finishedJobs.length, failed: failedJobs.length, cancelled: finishedJobs.filter((x) => x.j.status === "cancelled").length, rate: finishedJobs.length ? round(failedJobs.length / finishedJobs.length, 3) : 0, byStatus: jobStatuses, retries, retryShare: cur.jobs.length ? round(retries / cur.jobs.length, 3) : 0 },
  };

  // ----------------------------------------------------------- tools
  const mcpTotals = new Map<string, number>();
  const builtin = new Map<string, number>();
  for (const x of cur.jobs) {
    for (const [k, n] of Object.entries(x.j.mcp)) mcpTotals.set(k, (mcpTotals.get(k) ?? 0) + n);
    for (const [k, n] of Object.entries(x.j.tools)) builtin.set(k, (builtin.get(k) ?? 0) + n);
  }
  const servers = [...mcpTotals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const tools = {
    buckets,
    mcp: servers.map((server) => ({
      server,
      total: mcpTotals.get(server)!,
      jobs: cur.jobs.filter((x) => (x.j.mcp[server] ?? 0) > 0).length,
      counts: buckets.map((b) => sum(cur.jobs.filter((x) => bucketOf(x.day) === b).map((x) => x.j.mcp[server] ?? 0))),
    })),
    builtin: [...builtin.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tool, count]) => ({ tool, count })),
  };

  // ---------------------------------------------------------- memory
  const isProposal = (m: Memory) => m.origin === "proposal" || (m.origin === "remember" && !!m.why);
  const inCur = (iso: string | null) => !!iso && within(dayOf(iso, tz), p.from, p.to);
  const inPrev = (iso: string | null) => !!iso && within(dayOf(iso, tz), p.prevFrom, p.prevTo);
  const memStats = (inRange: (iso: string | null) => boolean) => ({
    proposed: input.memories.filter((m) => isProposal(m) && inRange(m.createdAt)).length,
    accepted: input.memories.filter((m) => isProposal(m) && m.status !== "proposed" && m.status !== "rejected" && inRange(m.decidedAt)).length,
    rejected: input.memories.filter((m) => m.status === "rejected" && inRange(m.decidedAt)).length,
    remembered: input.memories.filter((m) => m.origin === "remember" && !m.why && inRange(m.createdAt)).length,
  });
  const curMem = memStats(inCur);
  const prevMem = memStats(inPrev);
  const memory = {
    proposed: { cur: curMem.proposed, prev: prevMem.proposed },
    accepted: { cur: curMem.accepted, prev: prevMem.accepted },
    rejected: { cur: curMem.rejected, prev: prevMem.rejected },
    remembered: { cur: curMem.remembered, prev: prevMem.remembered },
    waiting: headline.proposalsWaiting,
    stale: input.memories.filter((m) => m.status === "active" && input.now - Date.parse(m.lastUsedAt ?? m.createdAt) > STALE_MS).length,
    scopes: input.scopes.map((s) => {
      const b = input.budgets[s.scope];
      return {
        scope: s.scope,
        name: s.name,
        avatar: s.avatar,
        active: input.memories.filter((m) => m.scope === s.scope && m.status === "active").length,
        proposals: input.memories.filter((m) => m.scope === s.scope && isProposal(m) && inCur(m.createdAt)).length,
        used: b?.used ?? 0,
        budget: b?.budget ?? 0,
        omitted: b?.omitted.length ?? 0,
      };
    }),
  };

  return {
    range: input.range,
    granularity,
    generatedAt: new Date(input.now).toISOString(),
    period: { from: p.from, to: p.to, prevFrom: p.prevFrom, prevTo: p.prevTo },
    coverage: {
      ...input.coverage,
      runsSince: input.runs[0]?.createdAt ?? null,
      jobsSince: input.jobs[0]?.startedAt ?? null,
      hasJobs: input.jobs.length > 0,
    },
    headline,
    tokensDaily,
    modelPreference,
    roles,
    topTasks,
    taskFlow,
    reliability,
    tools,
    memory,
  };
}

export type Stats = ReturnType<typeof computeStats>;

/** Weekly tokens per agent for the Crew tiles' sparklines: the last `weeks` weeks, this one included. */
export function weeklyTokens(input: { now: number; tz: string; runs: RunRow[]; jobs: JobRow[]; tasks: TaskFact[]; weeks?: number }): { weeks: string[]; agents: Record<string, number[]> } {
  const n = input.weeks ?? 8;
  const thisWeek = weekOf(dayOf(new Date(input.now).toISOString(), input.tz));
  const weeks = Array.from({ length: n }, (_, i) => addDays(thisWeek, -7 * (n - 1 - i)));
  const index = new Map(weeks.map((w, i) => [w, i]));
  const assignee = new Map(input.tasks.map((t) => [t.id, t.assigneeAgentId]));
  const agents: Record<string, number[]> = {};
  const add = (id: string | null | undefined, iso: string, tokens: number) => {
    const i = index.get(weekOf(dayOf(iso, input.tz)));
    if (!id || i === undefined) return;
    (agents[id] ??= weeks.map(() => 0))[i]! += tokens;
  };
  for (const r of input.runs) add(r.agentId, r.createdAt, total(runTokens(r)));
  for (const j of input.jobs) add(j.agentId ?? assignee.get(j.issueId), j.startedAt, total(jobTokens(j)));
  return { weeks, agents };
}

export { GLOBAL };
