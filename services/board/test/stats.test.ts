import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { PaperclipError, type Agent, type Issue, type Paperclip } from "../src/paperclip.js";
import { JobUsageSchema, UsageReportSchema, factFromIssue, markerSource, runFromApi, type JobUsage, type RawRun, type RunRow, type TaskFact } from "../src/stats.js";
import { agentInfos, computeStats, errorLabel, executorKey, nonDefault, periodOf, quantile, weekOf, weeklyTokens, type StatsInput } from "../src/statsmath.js";
import { backingOff, syncRuns, syncTasks } from "../src/statssync.js";
import { Store } from "../src/store.js";

const log = pino({ level: "silent" });
const persona = (name: string) => ({ persona: { name, voice: "", avatar: name.toLowerCase() } });
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const agents: Agent[] = [
  { id: ID(901), name: "Assistant", status: "idle", adapterType: "codex_local", metadata: { setupKey: "pennyworth:assistant", ...persona("Alfred") } },
  { id: ID(902), name: "Engineer", status: "idle", adapterType: "claude_local", metadata: { setupKey: "pennyworth:engineer-claude", runnerEngine: true, role: { job: "Builds", engine: "claude", model: "claude-opus-5-5" }, ...persona("Ada") } as Agent["metadata"] },
  { id: ID(903), name: "Reviewer", status: "idle", adapterType: "opencode_local", metadata: { setupKey: "pennyworth:reviewer", runnerEngine: true, role: { job: "Reviews", engine: "claude", model: "claude-opus-5-5" }, ...persona("Linus") } as Agent["metadata"] },
  { id: ID(904), name: "Slack Scout", status: "idle", adapterType: "codex_local", metadata: { setupKey: "pennyworth:slack-scout" } },
  { id: ID(905), name: "Chief of Staff", status: "idle", adapterType: "codex_local", metadata: { setupKey: "pennyworth:chief-of-staff" } },
];
const [ALFRED, ADA, LINUS, SCOUT, COS] = agents.map((a) => a.id);
const isCrew = (a: Agent) => !!(a.metadata as { persona?: unknown })?.persona;

const job = (over: Partial<JobUsage> = {}): JobUsage => ({
  id: 1,
  issueId: ID(1),
  identifier: "PEN-1",
  agentId: ADA!,
  engine: "claude",
  engineLabel: "Claude Code (claude-opus-5-5)",
  model: "claude-opus-5-5",
  effort: "high",
  status: "done",
  startedAt: "2026-11-10T10:00:00Z",
  finishedAt: "2026-11-10T10:20:00Z",
  resumed: false,
  restarted: false,
  retry: false,
  inputTokens: 1000,
  cacheReadTokens: 50_000,
  cacheWriteTokens: 2000,
  outputTokens: 3000,
  reasoningTokens: 0,
  costUsd: 1.5,
  contextTokens: 80_000,
  turns: 12,
  subagents: 0,
  tools: { Bash: 10, Read: 4 },
  mcp: { primer: 2 },
  ...over,
});

const issue = (over: Partial<Issue>): Issue => ({ id: ID(1), identifier: "PEN-1", title: "T", description: "", status: "todo", priority: "medium", assigneeUserId: "me", assigneeAgentId: null, assigneeAdapterOverrides: null, labels: [], createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-01T10:00:00Z", ...over });

// --------------------------------------------------------------------- schema

describe("the runner's usage report", () => {
  it("takes a job as specified", () => {
    expect(JobUsageSchema.parse(job())).toMatchObject({ id: 1, engine: "claude" });
    expect(UsageReportSchema.safeParse({ jobs: [job(), job({ id: 2, agentId: null, model: null, costUsd: null, finishedAt: null })] }).success).toBe(true);
  });

  it("is strict: unknown fields, engines, bad dates, negatives and too many jobs are refused", () => {
    expect(JobUsageSchema.safeParse({ ...job(), extra: 1 }).success).toBe(false);
    expect(JobUsageSchema.safeParse(job({ engine: "gpt" as JobUsage["engine"] })).success).toBe(false);
    expect(JobUsageSchema.safeParse(job({ startedAt: "yesterday" })).success).toBe(false);
    expect(JobUsageSchema.safeParse(job({ inputTokens: -1 })).success).toBe(false);
    expect(JobUsageSchema.safeParse(job({ identifier: "pen 1" })).success).toBe(false);
    expect(UsageReportSchema.safeParse({ jobs: Array.from({ length: 201 }, (_, i) => job({ id: i + 1 })) }).success).toBe(false);
    expect(UsageReportSchema.safeParse({ jobs: [], more: true }).success).toBe(false);
  });
});

// ----------------------------------------------------------------- task facts

describe("a task's source", () => {
  it("comes from its own marker", () => {
    expect(markerSource("x\n<!-- source:source:slack:pin:C0AF0:1794.6 -->")).toBe("slack-pin");
    expect(markerSource("<!-- source:source:slack:D0C9:1794.1 -->")).toBe("slack");
    expect(markerSource("<!-- source:source:source:slack:pin:C0B:1792.8 -->")).toBe("slack-pin");
    expect(markerSource("<!-- source:source:telegram:tg:-100348:198 -->")).toBe("telegram");
    expect(markerSource("<!-- source:source:gmail:label:1a15 -->")).toBe("gmail");
    expect(markerSource("<!-- source:meeting:434h5:action:3764 -->")).toBe("meeting");
    expect(markerSource("<!-- source:review:match:local_transcript:28 -->")).toBe("meeting");
    expect(markerSource("<!-- source:brief:2026-11-12 -->")).toBe("brief");
    expect(markerSource("<!-- source:recurring:PEN-565:2026-10-08T16:20 -->")).toBe("recurring");
    expect(markerSource("<!-- source:source:github:0xsequence/issue-tracker:issue:7372 -->")).toBe("github");
    expect(markerSource("<!-- source:subtask:PEN-1756:node-gateway -->")).toBe("crew");
    expect(markerSource("<!-- source:test:merge-dup -->")).toBe("other");
    // A merged duplicate's marker isn't the task's own source (D-56).
    expect(markerSource("<!-- merged-source:source:slack:C1:1.2 -->")).toBeUndefined();
    expect(markerSource("plain")).toBeUndefined();
  });

  it("falls back on who made it, and marks crew parts", () => {
    const fact = (over: Partial<Issue>) => factFromIssue(issue(over), agents, isCrew);
    expect(fact({ createdByUserId: "me" }).source).toBe("you");
    expect(fact({ createdByAgentId: COS, labels: [{ id: "l", name: "daily-brief", color: "" }] }).source).toBe("brief");
    expect(fact({ createdByAgentId: SCOUT }).source).toBe("slack");
    expect(fact({ createdByAgentId: ALFRED }).source).toBe("agent");
    const part = fact({ parentId: ID(2), assigneeAgentId: ADA, createdByUserId: "me" });
    expect(part).toMatchObject({ part: true, source: "crew" });
    // A sub-task assigned to the user isn't a part.
    expect(fact({ parentId: ID(2), createdByUserId: "me" }).part).toBe(false);
  });

  it("closes at its completion or cancellation time", () => {
    expect(factFromIssue(issue({ status: "done", completedAt: "2026-11-02T00:00:00Z" }), agents, isCrew).closedAt).toBe("2026-11-02T00:00:00Z");
    expect(factFromIssue(issue({ status: "cancelled", cancelledAt: "2026-11-03T00:00:00Z" }), agents, isCrew).closedAt).toBe("2026-11-03T00:00:00Z");
    expect(factFromIssue(issue({ status: "todo", completedAt: null }), agents, isCrew).closedAt).toBeNull();
  });
});

describe("a Paperclip run", () => {
  it("keeps tokens, the first line of its error and whether it's a retry", () => {
    const r = runFromApi({ id: "r1", agentId: SCOUT!, status: "failed", createdAt: "2026-11-01T00:00:00Z", error: "Error: timed out waiting for cloud config bundle after 20s\nstack…", retryOfRunId: "r0", contextSnapshot: { issueId: ID(1) }, usageJson: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 5, model: "unknown", costStatus: "unpriced" } } as RawRun);
    expect(r).toMatchObject({ issueId: ID(1), inputTokens: 100, cachedInputTokens: 80, outputTokens: 5, error: "Error: timed out waiting for cloud config bundle after 20s", retry: true, costStatus: "unpriced" });
    expect(runFromApi({ id: "r2", agentId: SCOUT!, status: "succeeded", createdAt: "x" }).inputTokens).toBe(0);
  });

  it("folds error lines into causes", () => {
    const e = (error: string, errorCode: string | null = null) => errorLabel({ error, errorCode, status: "failed" });
    expect(e("Error: timed out waiting for cloud config bundle after 20s")).toBe("Codex cloud config timed out");
    expect(e("Selected model is at capacity. Please try a different model.")).toBe("Model at capacity");
    expect(e("", "refresh_token_invalidated")).toBe("Sign-in expired (invalid_grant)");
    expect(e("Process lost -- child pid 1675 is no longer running; retrying once")).toBe("Process lost");
    expect(e("Something new 1234")).toBe("Something new #");
  });
});

// ------------------------------------------------------------------- store

describe("the stats tables", () => {
  it("upsert jobs by id, runs and tasks", () => {
    const s = new Store(":memory:").stats;
    s.upsertJobs([job(), job({ id: 2 })]);
    s.upsertJobs([job({ status: "failed", costUsd: 2 })]);
    expect(s.jobs().map((j) => [j.id, j.status, j.costUsd])).toEqual([
      [1, "failed", 2],
      [2, "done", 1.5],
    ]);
    expect(s.jobs()[0]!.tools).toEqual({ Bash: 10, Read: 4 });
    expect(s.meta("jobs_reported_at")).toBeTruthy();
  });
});

// -------------------------------------------------------------------- sync

/** A fake Paperclip with N runs (newest first) and paged issues; it counts calls and can answer 429. */
function fakePaperclip(opts: { runs: RawRun[]; issues?: Issue[]; full?: Map<string, Issue>; busy?: number }) {
  const calls: string[] = [];
  let busy = opts.busy ?? 0;
  const pc = {
    agents: async () => agents,
    runsWithUsage: async ({ limit, agentId }: { limit?: number; agentId?: string } = {}) => {
      calls.push(`runs:${limit ?? "all"}:${agentId ? "agent" : "-"}`);
      if (busy > 0) {
        busy--;
        throw new PaperclipError("Paperclip GET → 429: slow down", 429);
      }
      const list = opts.runs.filter((r) => !agentId || r.agentId === agentId);
      return limit ? list.slice(0, limit) : list;
    },
    issuesPage: async ({ offset, limit, updatedSince }: { offset: number; limit: number; updatedSince?: string }) => {
      calls.push(`issues:${offset}:${updatedSince ? "since" : "all"}`);
      return (opts.issues ?? []).filter((i) => !updatedSince || i.updatedAt >= updatedSince).slice(offset, offset + limit);
    },
    issue: async (id: string) => {
      calls.push(`issue:${id}`);
      return opts.full!.get(id)!;
    },
  } as unknown as Paperclip;
  return { pc, calls };
}

const rawRun = (n: number, at: number, over: Partial<RawRun> = {}): RawRun => ({ id: `run-${n}`, agentId: n % 2 ? SCOUT! : ALFRED!, status: "succeeded", createdAt: new Date(at).toISOString(), finishedAt: new Date(at + 60_000).toISOString(), usageJson: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 1 }, ...over });

describe("syncing Paperclip's runs", () => {
  const NOW = Date.parse("2026-11-12T12:00:00Z");
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);

  it("copies everything agent by agent first, then only the newest page", async () => {
    // 300 runs, one every 10 minutes, newest first.
    const runs = Array.from({ length: 300 }, (_, i) => rawRun(i, NOW - i * 600_000));
    const store = new Store(":memory:");
    const { pc, calls } = fakePaperclip({ runs });
    const first = await syncRuns({ pc, stats: store.stats, log, sleep, now: () => NOW });
    expect(first).toMatchObject({ mode: "backfill", fetched: 300 });
    expect(calls.filter((c) => c.endsWith(":agent"))).toHaveLength(agents.length);
    expect(store.stats.runCount()).toBe(300);
    calls.length = 0;
    // Five minutes later: two new runs. One page of 200 reaches back past the last sync.
    runs.unshift(rawRun(1001, NOW + 240_000), rawRun(1002, NOW + 120_000));
    const next = await syncRuns({ pc, stats: store.stats, log, sleep, now: () => NOW + 300_000 });
    expect(next).toMatchObject({ mode: "recent", changed: 2 });
    expect(calls).toEqual(["runs:200:-"]);
    expect(store.stats.runCount()).toBe(302);
  });

  it("goes back for runs still unfinished, and updates them when they end", async () => {
    const runs = Array.from({ length: 300 }, (_, i) => rawRun(i, NOW - i * 60_000));
    // Run 250 (250 minutes ago) was still running at the first copy.
    runs[250] = rawRun(250, NOW - 250 * 60_000, { status: "running", finishedAt: null });
    const store = new Store(":memory:");
    const { pc, calls } = fakePaperclip({ runs });
    await syncRuns({ pc, stats: store.stats, log, sleep, now: () => NOW });
    calls.length = 0;
    runs[250] = rawRun(250, NOW - 250 * 60_000, { status: "failed", error: "Process lost" });
    const r = await syncRuns({ pc, stats: store.stats, log, sleep, now: () => NOW + 60_000 });
    // 200 doesn't reach back 250 minutes: the sync asks for 1,000.
    expect(calls).toEqual(["runs:200:-", "runs:1000:-"]);
    expect(r).toMatchObject({ mode: "recent", changed: 1 });
    expect(store.stats.runs().find((x) => x.id === "run-250")).toMatchObject({ status: "failed", error: "Process lost" });
  });

  it("leaves a run unfinished for more than two days alone", async () => {
    const runs = Array.from({ length: 300 }, (_, i) => rawRun(i, NOW - i * 3_600_000));
    runs[100] = rawRun(100, NOW - 100 * 3_600_000, { status: "running", finishedAt: null });
    const store = new Store(":memory:");
    const { pc, calls } = fakePaperclip({ runs });
    await syncRuns({ pc, stats: store.stats, log, sleep, now: () => NOW });
    calls.length = 0;
    await syncRuns({ pc, stats: store.stats, log, sleep, now: () => NOW + 300_000 });
    expect(calls).toEqual(["runs:200:-"]);
  });

  it("copies everything again when more than 1,000 runs came since the last sync", async () => {
    const runs = [rawRun(1, NOW)];
    const store = new Store(":memory:");
    const { pc, calls } = fakePaperclip({ runs });
    await syncRuns({ pc, stats: store.stats, log, sleep, now: () => NOW });
    for (let i = 0; i < 1200; i++) runs.unshift(rawRun(10_000 + i, NOW + 3_600_000 + i * 1000));
    calls.length = 0;
    const r = await syncRuns({ pc, stats: store.stats, log, sleep, now: () => NOW + 2 * 3_600_000 + 1_200_000 });
    expect(r.mode).toBe("backfill");
    expect(store.stats.runCount()).toBe(1201);
  });

  it("backs off on 429 and gives up after a while", async () => {
    const waits: number[] = [];
    let n = 0;
    const ok = await backingOff(async () => (++n < 3 ? Promise.reject(new PaperclipError("429", 429)) : "ok"), async (ms) => void waits.push(ms));
    expect(ok).toBe("ok");
    expect(waits).toEqual([2000, 4000]);
    await expect(backingOff(async () => Promise.reject(new PaperclipError("429", 429)), async () => {}, 3)).rejects.toThrow("429");
    await expect(backingOff(async () => Promise.reject(new PaperclipError("404", 404)), async () => {})).rejects.toThrow("404");
    // Through the sync: two 429s, then the copy goes on.
    const store = new Store(":memory:");
    const { pc } = fakePaperclip({ runs: [rawRun(1, NOW)], busy: 2 });
    expect((await syncRuns({ pc, stats: store.stats, log, sleep, now: () => NOW })).fetched).toBe(1);
  });
});

describe("syncing task facts", () => {
  const NOW = Date.parse("2026-11-12T12:00:00Z");
  const sleep = async () => {};

  it("pages through every task, fetches cut-short descriptions once, then only changes", async () => {
    const issues = Array.from({ length: 1200 }, (_, i) => issue({ id: ID(i + 1), identifier: `PEN-${i + 1}`, createdByUserId: "me", updatedAt: "2026-11-01T00:00:00Z" }));
    issues[5] = issue({ id: ID(6), identifier: "PEN-6", description: "long text…", descriptionTruncated: true, createdByAgentId: SCOUT, updatedAt: "2026-11-01T00:00:00Z" });
    const full = new Map([[ID(6), { ...issues[5]!, description: "long text\n<!-- source:source:slack:pin:C1:1.2 -->" }]]);
    const store = new Store(":memory:");
    const { pc, calls } = fakePaperclip({ runs: [], issues, full });
    const first = await syncTasks({ pc, stats: store.stats, log, sleep, now: () => NOW });
    expect(first).toEqual({ full: true, fetched: 1200, fullFetches: 1 });
    expect(calls).toEqual(["issues:0:all", "issue:" + ID(6), "issues:500:all", "issues:1000:all"]);
    expect(store.stats.tasks().find((t) => t.identifier === "PEN-6")?.source).toBe("slack-pin");
    // An hour later: only what changed, and the kept source isn't fetched again.
    issues[5] = { ...issues[5]!, status: "done", completedAt: "2026-11-12T12:30:00Z", updatedAt: "2026-11-12T12:30:00Z" };
    calls.length = 0;
    const next = await syncTasks({ pc, stats: store.stats, log, sleep, now: () => NOW + 3_600_000 });
    expect(next).toEqual({ full: false, fetched: 1, fullFetches: 0 });
    expect(calls).toEqual(["issues:0:since"]);
    expect(store.stats.tasks().find((t) => t.identifier === "PEN-6")).toMatchObject({ source: "slack-pin", status: "done", closedAt: "2026-11-12T12:30:00Z" });
    // A day on: the full copy again.
    calls.length = 0;
    expect((await syncTasks({ pc, stats: store.stats, log, sleep, now: () => NOW + 26 * 3_600_000 })).full).toBe(true);
  });
});

// -------------------------------------------------------------------- math

describe("periods", () => {
  it("are the last N local days, compared with the N before", () => {
    const p = periodOf("7d", Date.parse("2026-11-12T23:30:00Z"), "Europe/Madrid");
    // 00:30 on the 13th in Madrid.
    expect(p).toMatchObject({ from: "2026-11-07", to: "2026-11-13", prevFrom: "2026-10-31", prevTo: "2026-11-06" });
    expect(p.days).toHaveLength(7);
    expect(weekOf("2026-11-12")).toBe("2026-11-09");
    expect(weekOf("2026-11-09")).toBe("2026-11-09");
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.9)).toBeNull();
  });
});

describe("executors", () => {
  it("name the engine and model, and tell when a job left the role's default", () => {
    expect(executorKey("codex", null)).toBe("Codex · Codex default");
    expect(executorKey("claude", "claude-opus-5-5")).toBe("Claude Code · claude-opus-5-5");
    const role = { engine: "claude", model: "claude-opus-5-5" };
    expect(nonDefault({ engine: "claude", model: "claude-opus-5-5" }, role)).toBe(false);
    expect(nonDefault({ engine: "claude", model: null }, role)).toBe(false);
    expect(nonDefault({ engine: "claude", model: "claude-sonnet-5" }, role)).toBe(true);
    expect(nonDefault({ engine: "codex", model: null }, role)).toBe(true);
    expect(nonDefault({ engine: "codex", model: null }, null)).toBe(false);
  });
});

describe("the stats", () => {
  const NOW = Date.parse("2026-11-12T18:00:00Z");
  const run = (n: number, over: Partial<RunRow>): RunRow => ({ id: `r${n}`, agentId: SCOUT!, issueId: null, status: "succeeded", invocationSource: "assignment", createdAt: "2026-11-10T09:00:00Z", startedAt: "2026-11-10T09:00:00Z", finishedAt: "2026-11-10T09:02:00Z", errorCode: null, error: null, inputTokens: 1000, cachedInputTokens: 800, outputTokens: 10, model: "unknown", costStatus: "unpriced", billingType: "subscription_included", retry: false, ...over });
  const task = (n: number, over: Partial<TaskFact>): TaskFact => ({ id: ID(n), identifier: `PEN-${n}`, title: `Task ${n}`, parentId: null, status: "todo", createdAt: "2026-11-10T09:00:00Z", closedAt: null, assigneeAgentId: null, assigneeUserId: "me", createdByAgentId: null, createdByUserId: "me", labels: [], source: "you", part: false, ...over });
  const input = (over: Partial<StatsInput> = {}): StatsInput => ({
    range: "7d",
    now: NOW,
    tz: "UTC",
    agents: agentInfos(agents),
    jobs: [
      { ...job({ id: 1, issueId: ID(10), identifier: "PEN-10", costUsd: 4 }), updatedAt: "" },
      { ...job({ id: 2, issueId: ID(10), identifier: "PEN-10", costUsd: 2, contextTokens: 300_000, restarted: true, retry: true, status: "failed", startedAt: "2026-11-11T10:00:00Z", finishedAt: "2026-11-11T10:40:00Z" }), updatedAt: "" },
      { ...job({ id: 3, issueId: ID(11), identifier: "PEN-11", agentId: null, engine: "codex", model: null, costUsd: null, mcp: { grafana: 3 }, tools: { Bash: 1 } }), updatedAt: "" },
      // Last period: one job.
      { ...job({ id: 4, startedAt: "2026-11-01T10:00:00Z", costUsd: 1 }), updatedAt: "" },
    ],
    runs: [
      run(1, {}),
      run(2, { status: "failed", error: "Error: timed out waiting for cloud config bundle after 20s", retry: true }),
      run(3, { status: "cancelled", errorCode: "issue_reassigned", error: "Cancelled before issue reassignment" }),
      run(4, { agentId: ALFRED!, issueId: ID(10), inputTokens: 500, cachedInputTokens: 0 }),
      run(5, { createdAt: "2026-11-02T09:00:00Z" }),
    ],
    tasks: [
      task(10, { source: "slack-pin", status: "done", createdAt: "2026-11-10T09:00:00Z", closedAt: "2026-11-10T19:00:00Z", title: "Expensive" }),
      task(11, { parentId: ID(10), part: true, source: "crew", assigneeAgentId: LINUS!, assigneeUserId: null }),
      task(12, { source: "slack", createdAt: "2026-11-09T09:00:00Z" }),
      task(13, { source: "you", createdAt: "2026-11-01T09:00:00Z", status: "done", closedAt: "2026-11-02T09:00:00Z" }),
    ],
    memories: [],
    budgets: {},
    scopes: [],
    coverage: { runsSyncedAt: null, tasksSyncedAt: null, jobsReportedAt: null },
    ...over,
  });

  it("puts headline numbers next to the period before", () => {
    const s = computeStats(input());
    expect(s.period).toMatchObject({ from: "2026-11-06", to: "2026-11-12" });
    expect(s.headline.costUsd).toEqual({ cur: 6, prev: 1 });
    expect(s.headline.jobs).toEqual({ cur: 3, prev: 1 });
    expect(s.headline.runs).toEqual({ cur: 4, prev: 1 });
    expect(s.headline.unpricedJobs).toBe(1);
    // Parts aren't the user's tasks: two created this week (10, 12), one closed (10); last week 13.
    expect(s.headline.tasksCreated).toEqual({ cur: 2, prev: 1 });
    expect(s.headline.tasksClosed).toEqual({ cur: 1, prev: 1 });
    const runTokens = 3 * 1010 + 510;
    const jobTokens = 3 * (1000 + 50_000 + 2000 + 3000);
    expect(s.headline.tokens.cur).toBe(runTokens + jobTokens);
  });

  it("stacks tokens by fixed groups per day, cached apart", () => {
    const s = computeStats(input());
    const engineers = s.tokensDaily.groups.find((g) => g.key === "engineers")!;
    const i = s.tokensDaily.days.indexOf("2026-11-10");
    // Jobs 1 and 3 on the 10th (3's role comes from its task's assignee, Linus).
    expect(engineers.cached[i]).toBe(100_000);
    expect(engineers.uncached[i]).toBe(6000);
    const slack = s.tokensDaily.groups.find((g) => g.key === "slack")!;
    expect(slack.cached[i]).toBe(2400);
    expect(s.tokensDaily.groups.map((g) => g.key)).toEqual(["assistant", "writer", "engineers", "slack", "telegram", "meetings", "brief"]);
  });

  it("tells model preference per role and non-default executors", () => {
    const s = computeStats(input());
    const linus = s.modelPreference.roles.find((r) => r.name === "Linus")!;
    expect(linus).toMatchObject({ jobs: 1, nonDefaultJobs: 1, nonDefaultTasks: 1, defaultExecutor: "Claude Code · claude-opus-5-5" });
    expect(linus.executors).toEqual([{ key: "Codex · Codex default", jobs: 1 }]);
    expect(s.modelPreference.roles.find((r) => r.name === "Ada")).toMatchObject({ jobs: 2, nonDefaultJobs: 0 });
  });

  it("sums each role, and lists the most expensive tasks", () => {
    const s = computeStats(input());
    const ada = s.roles.find((r) => r.name === "Ada")!;
    expect(ada).toMatchObject({ tasks: 1, jobs: 2, jobsPerTask: 2, costUsd: 6, costPerTask: 6, maxContext: 300_000, restarted: 1, retries: 1, medianMinutes: 30 });
    const alfred = s.roles.find((r) => r.name === "Alfred")!;
    expect(alfred).toMatchObject({ kind: "paperclip", jobs: 1, tasks: 1, costUsd: null });
    expect(s.topTasks).toEqual([{ identifier: "PEN-10", parent: null, title: "Expensive", costUsd: 6, jobs: 2, peakContext: 300_000, agent: "Ada", avatar: "ada" }]);
  });

  it("counts task flow by source, time to close and scout yield", () => {
    const s = computeStats(input());
    expect(s.taskFlow.sources).toEqual(["slack", "slack-pin"]);
    expect(s.taskFlow.timeToClose.find((t) => t.source === "slack-pin")).toMatchObject({ created: 1, done: 1, medianHours: 10 });
    expect(s.taskFlow.created.reduce((n, b) => n + Object.values(b.bySource).reduce((a, x) => a + (x ?? 0), 0), 0)).toBe(2);
    expect(s.taskFlow.scoutYield).toEqual([{ agentId: SCOUT, name: "Slack Scout", runs: 3, tasks: 2, perHundredRuns: 66.7 }]);
  });

  it("measures reliability with causes, and runner retries", () => {
    const s = computeStats(input());
    const scout = s.reliability.agents.find((a) => a.agentId === SCOUT)!;
    expect(scout).toMatchObject({ runs: 3, failed: 1, cancelled: 1, rate: 0.333 });
    expect(scout.errors.map((e) => e.label)).toEqual(["Codex cloud config timed out", "Cancelled: task reassigned"]);
    expect(s.reliability.runs).toEqual({ total: 4, failed: 1, cancelled: 1, retried: 1 });
    expect(s.reliability.runner).toMatchObject({ jobs: 3, failed: 1, retries: 1, retryShare: 0.333 });
  });

  it("counts MCP servers and tools", () => {
    const s = computeStats(input());
    expect(s.tools.mcp.map((m) => [m.server, m.total, m.jobs])).toEqual([
      ["grafana", 3, 1],
      ["primer", 4, 2],
    ].sort((a, b) => (b[1] as number) - (a[1] as number)));
    expect(s.tools.builtin[0]).toEqual({ tool: "Bash", count: 21 });
  });

  it("measures memory: proposals made and decided, budgets and stale ones", () => {
    const m = (over: object) => ({ id: 1, scope: "engineer-claude", kind: "lesson", text: "x", status: "active", pinned: false, sensitive: false, origin: "proposal", createdBy: "Ada", why: "w", sourceIssue: null, sourceComment: null, createdAt: "2026-11-10T00:00:00Z", updatedAt: "", decidedAt: "2026-11-11T00:00:00Z", lastUsedAt: "2026-11-11T00:00:00Z", uses: 0, ...over });
    const s = computeStats(
      input({
        memories: [
          m({}),
          m({ id: 2, status: "rejected" }),
          m({ id: 3, status: "proposed", decidedAt: null }),
          m({ id: 4, origin: "remember", why: null, createdAt: "2026-11-11T00:00:00Z" }),
          m({ id: 5, origin: "board", why: null, createdAt: "2026-09-01T00:00:00Z", lastUsedAt: null, decidedAt: "2026-09-01T00:00:00Z" }),
        ] as never,
        budgets: { "engineer-claude": { used: 100, budget: 8000, included: [1], omitted: [] } },
        scopes: [{ scope: "engineer-claude", name: "Ada", avatar: "ada" }],
      }),
    );
    expect(s.memory).toMatchObject({ proposed: { cur: 3 }, accepted: { cur: 1 }, rejected: { cur: 1 }, remembered: { cur: 1 }, waiting: 1, stale: 1 });
    expect(s.memory.scopes[0]).toMatchObject({ name: "Ada", active: 3, proposals: 3, used: 100, budget: 8000 });
  });

  it("gives each agent weekly tokens for the Crew sparklines", () => {
    const i = input();
    const w = weeklyTokens({ now: NOW, tz: "UTC", runs: i.runs, jobs: i.jobs, tasks: i.tasks, weeks: 3 });
    expect(w.weeks).toEqual(["2026-10-26", "2026-11-02", "2026-11-09"]);
    expect(w.agents[SCOUT!]).toEqual([0, 1010, 3030]);
    expect(w.agents[LINUS!]).toEqual([0, 0, 56_000]);
  });
});

// ------------------------------------------------------------------ routes

describe("stats routes", () => {
  const TOKEN = "t".repeat(64);
  const store = new Store(":memory:");
  const pc = { me: async () => "me", agents: async () => agents, labels: async () => [], company: async () => ({ issuePrefix: "PEN" }) } as unknown as Paperclip;
  const internal = createApp({ paperclip: pc, store, log, allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN });
  const local = createApp({ paperclip: pc, store, log, allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", mode: "local" });
  const lan = createApp({ paperclip: pc, store, log, allowedHosts: ["pennyworth.local"], staticDir: "/nonexistent", timezone: "UTC", mode: "lan", lan: { clients: ["127.0.0.0/8"], url: "http://pennyworth.local" } });
  const ports: number[] = [];
  beforeAll(async () => {
    for (const s of [internal, local, lan]) {
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      ports.push((s.address() as AddressInfo).port);
    }
  });
  afterAll(() => [internal, local, lan].forEach((s) => s.close()));
  const call = (port: number, method: string, path: string, body: unknown, headers: Record<string, string>) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: text }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const usage = (body: unknown, auth = `Bearer ${TOKEN}`) => call(ports[0]!, "POST", "/internal/runner/usage", body, { host: "board:3122", "content-type": "application/json", authorization: auth });

  it("takes the runner's usage with the internal token only, validated", async () => {
    expect((await usage({ jobs: [job()] }, "Bearer nope")).status).toBe(401);
    expect((await usage({ jobs: [job()] }, "")).status).toBe(401);
    expect((await usage({ jobs: [{ ...job(), surprise: 1 }] })).status).toBe(400);
    const ok = await usage({ jobs: [job(), job({ id: 2 })] });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ok: true, jobs: 2 });
    expect(store.stats.jobs()).toHaveLength(2);
    // Not on the user's listener.
    expect((await call(ports[1]!, "POST", "/internal/runner/usage", { jobs: [] }, { host: "localhost:3120", "content-type": "application/json", "x-pennyworth-board": "1" })).status).toBe(405);
  });

  it("takes a full report of 200 jobs with their tool tallies", async () => {
    const tools = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`mcp__server_${i}__some_long_tool_name`, i]));
    const jobs = Array.from({ length: 200 }, (_, i) => job({ id: 100 + i, tools }));
    expect(JSON.stringify({ jobs }).length).toBeGreaterThan(256_000);
    expect((await usage({ jobs })).status).toBe(200);
  });

  it("serves the stats on the board's API under its usual checks", async () => {
    const get = (port: number, path: string, host: string) => call(port, "GET", path, undefined, { host });
    const r = await get(ports[1]!, "/api/stats?range=30d", "localhost:3120");
    expect(r.status).toBe(200);
    const s = JSON.parse(r.body);
    expect(s).toMatchObject({ range: "30d", granularity: "week" });
    expect(s.coverage.hasJobs).toBe(true);
    expect((await get(ports[1]!, "/api/stats", "localhost:3120")).status).toBe(200);
    expect((await get(ports[1]!, "/api/stats?range=1y", "localhost:3120")).status).toBe(400);
    expect((await get(ports[1]!, "/api/stats", "evil.example")).status).toBe(403);
    // The LAN listener: paired devices only.
    const unpaired = await get(ports[2]!, "/api/stats", "pennyworth.local");
    expect(unpaired.status).toBe(401);
    expect((await get(ports[1]!, "/api/stats/sparklines", "localhost:3120")).status).toBe(200);
    // Not on the internal listener.
    expect((await call(ports[0]!, "GET", "/api/stats", undefined, { host: "board:3122", authorization: `Bearer ${TOKEN}` })).status).toBe(404);
  });
});
