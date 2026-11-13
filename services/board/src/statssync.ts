// Keeping the Stats view's copy of Paperclip (D-62): agent runs every 5 minutes, task facts every hour,
// gently. Paperclip rate-limits list requests per client (D-22: the board's own poll shares that
// limit), so every call backs off on 429 and the syncs never run at the same time.
import type { Logger } from "pino";
import { personaOf } from "./board.js";
import type { Paperclip } from "./paperclip.js";
import { PaperclipError, type Issue } from "./paperclip.js";
import { factFromIssue, markerSource, runFromApi, type RawRun, type StatsStore } from "./stats.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A run unfinished for longer than this is left as it is (Paperclip lost it; the sync stops going back for it). */
export const RUN_RECHECK_MS = 2 * DAY_MS;
const RUN_PAGE = 200;
const ISSUE_PAGE = 500;
const isCrew = (a: Parameters<typeof personaOf>[0]) => !!personaOf(a);
const STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"]);

export interface SyncDeps {
  pc: Paperclip;
  stats: StatsStore;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

/** A Paperclip call, again after 2, 4, 8… seconds (at most a minute) while it answers 429 or 503. */
export async function backingOff<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void> = realSleep, tries = 6): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const busy = err instanceof PaperclipError && (err.status === 429 || err.status === 503);
      if (!busy || attempt >= tries - 1) throw err;
      await sleep(Math.min(2000 * 2 ** attempt, 60_000));
    }
  }
}

/**
 * New and changed agent runs. Paperclip's list has no offset or date filter, only the newest `limit`
 * (D-62), so a sync takes the newest 200, then more (1,000) while the page doesn't reach back to what it
 * needs: the previous sync, and any run kept as unfinished in the last 2 days (it's fetched again until
 * it finishes). Past 1,000 it falls back to the full copy, agent by agent. The first sync is that copy.
 */
export async function syncRuns(deps: SyncDeps): Promise<{ mode: "backfill" | "recent"; fetched: number; changed: number }> {
  const { pc, stats } = deps;
  const sleep = deps.sleep ?? realSleep;
  const now = (deps.now ?? Date.now)();
  const last = stats.meta("runs_synced_at");
  if (!last || stats.runCount() === 0) return backfillRuns(deps);
  const unfinished = stats.oldestUnfinishedRun(new Date(now - RUN_RECHECK_MS).toISOString());
  const lastNeeded = new Date(Date.parse(last) - HOUR_MS).toISOString();
  const needSince = unfinished && unfinished < lastNeeded ? unfinished : lastNeeded;
  for (let limit = RUN_PAGE; ; limit = 1000) {
    const page = (await backingOff(() => pc.runsWithUsage<RawRun>({ limit }), sleep)).map(runFromApi);
    const known = stats.finishedRunIds(page.map((r) => r.id));
    const changed = page.filter((r) => !known.has(r.id));
    stats.upsertRuns(changed);
    const reaches = page.length < limit || page.at(-1)!.createdAt <= needSince;
    if (reaches) {
      stats.setMeta("runs_synced_at", new Date(now).toISOString());
      return { mode: "recent", fetched: page.length, changed: changed.length };
    }
    if (limit >= 1000) {
      deps.log.warn({ needSince }, "stats: more than 1,000 runs since the last sync; copying them all again");
      return backfillRuns(deps);
    }
    await sleep(1000);
  }
}

/** Every run, one agent at a time with a pause between (a single unlimited request is about 13 MB). */
export async function backfillRuns(deps: SyncDeps): Promise<{ mode: "backfill"; fetched: number; changed: number }> {
  const { pc, stats, log } = deps;
  const sleep = deps.sleep ?? realSleep;
  const now = (deps.now ?? Date.now)();
  const agents = await backingOff(() => pc.agents(), sleep);
  let fetched = 0;
  for (const a of agents) {
    const runs = (await backingOff(() => pc.runsWithUsage<RawRun>({ agentId: a.id }), sleep)).map(runFromApi);
    stats.upsertRuns(runs);
    fetched += runs.length;
    await sleep(1000);
  }
  // Runs of agents no longer listed: the newest thousand catch most of them.
  const newest = (await backingOff(() => pc.runsWithUsage<RawRun>({ limit: 1000 }), sleep)).map(runFromApi);
  stats.upsertRuns(newest.filter((r) => !agents.some((a) => a.id === r.agentId)));
  stats.setMeta("runs_synced_at", new Date(now).toISOString());
  log.info({ runs: fetched, agents: agents.length }, "stats: agent runs copied");
  return { mode: "backfill", fetched, changed: fetched };
}

/**
 * Task facts: every task (routine runs left out) on the first sync and once a day, otherwise the ones
 * changed since the last sync (with 10 minutes of overlap). A description the list cut short loses its
 * source marker at the end, so a new task whose list copy has none is fetched in full, once.
 */
export async function syncTasks(deps: SyncDeps): Promise<{ full: boolean; fetched: number; fullFetches: number }> {
  const { pc, stats, log } = deps;
  const sleep = deps.sleep ?? realSleep;
  const now = (deps.now ?? Date.now)();
  const last = stats.meta("tasks_synced_at");
  const lastFull = stats.meta("tasks_full_at");
  const full = !last || !lastFull || stats.taskCount() === 0 || now - Date.parse(lastFull) > DAY_MS;
  const updatedSince = full ? undefined : new Date(Date.parse(last!) - 10 * 60_000).toISOString();
  const agents = await backingOff(() => pc.agents(), sleep);
  let fetched = 0;
  let fullFetches = 0;
  for (let offset = 0; ; offset += ISSUE_PAGE) {
    const page = (await backingOff(() => pc.issuesPage({ offset, limit: ISSUE_PAGE, updatedSince }), sleep)).filter((i) => STATUSES.has(i.status) && i.originKind !== "routine_execution");
    const known = stats.knownSources(page.map((i) => i.id));
    const facts = [];
    for (let i of page) {
      if (i.descriptionTruncated && !markerSource(i.description)) {
        const kept = known.get(i.id);
        if (kept) {
          facts.push({ ...factFromIssue(i, agents, isCrew), source: kept });
          continue;
        }
        i = await backingOff<Issue>(() => pc.issue(i.id), sleep).catch(() => i);
        fullFetches++;
        await sleep(200);
      }
      facts.push(factFromIssue(i, agents, isCrew));
    }
    stats.upsertTasks(facts);
    fetched += page.length;
    if (page.length < ISSUE_PAGE) break;
    await sleep(1000);
  }
  stats.setMeta("tasks_synced_at", new Date(now).toISOString());
  if (full) stats.setMeta("tasks_full_at", new Date(now).toISOString());
  if (full || fullFetches) log.info({ tasks: fetched, full, fullFetches }, "stats: task facts synced");
  return { full, fetched, fullFetches };
}

/** The timers: runs every 5 minutes, tasks every hour, one sync at a time; failures are logged and retried next time. */
export function startStatsSync(deps: SyncDeps, opts: { runsEveryMs?: number; tasksEveryMs?: number; firstAfterMs?: number } = {}): () => void {
  let busy: Promise<unknown> = Promise.resolve();
  const run = (name: string, fn: () => Promise<unknown>) => {
    busy = busy
      .then(fn)
      .catch((err) => deps.log.warn({ err: String((err as Error).message ?? err).slice(0, 300) }, `stats: ${name} sync failed`));
  };
  const runs = () => run("runs", () => syncRuns(deps));
  const tasks = () => run("tasks", () => syncTasks(deps));
  const first = setTimeout(() => (runs(), tasks()), opts.firstAfterMs ?? 30_000);
  const a = setInterval(runs, opts.runsEveryMs ?? 5 * 60_000);
  const b = setInterval(tasks, opts.tasksEveryMs ?? HOUR_MS);
  for (const t of [first, a, b]) t.unref?.();
  return () => (clearTimeout(first), clearInterval(a), clearInterval(b));
}

