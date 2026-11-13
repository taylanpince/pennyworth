// Stats routes (D-62): the runner's per-job usage on the internal API, and the Stats view's one
// precomputed payload (plus the Crew tiles' weekly sparklines) on the board's own API.
import type { Logger } from "pino";
import { z } from "zod";
import { BadRequest } from "./board.js";
import { crewScopes } from "./memoryapi.js";
import type { MemoryStore } from "./memory.js";
import { GLOBAL } from "./memory.js";
import type { Paperclip } from "./paperclip.js";
import { RANGES, addDays, agentInfos, computeStats, dayOf, periodOf, weeklyTokens, type RangeKey } from "./statsmath.js";
import { UsageReportSchema, type StatsStore } from "./stats.js";

type Route = { method: string; path: RegExp; maxBody?: number; handle: (m: RegExpMatchArray, body: unknown, url: URL) => Promise<unknown> };

export interface StatsDeps {
  paperclip: Paperclip;
  stats: StatsStore;
  memory: MemoryStore;
  timezone: string;
  log: Logger;
  now?: () => number;
}

/** 200 jobs with their tool tallies fit easily; the internal default of 256 kB might not. */
export const USAGE_MAX_BODY = 2_000_000;

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequest(r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

export function statsRoutes({ paperclip: pc, stats, memory, timezone, log, now = Date.now }: StatsDeps) {
  const internal: Route[] = [
    {
      // The runner's Engineer jobs, each with its usage, upserted by the job's id.
      method: "POST",
      path: /^\/internal\/runner\/usage$/,
      maxBody: USAGE_MAX_BODY,
      handle: async (_m, body) => {
        const { jobs } = parse(UsageReportSchema, body);
        const n = stats.upsertJobs(jobs);
        log.debug({ jobs: n }, "runner usage recorded");
        return { ok: true, jobs: n };
      },
    },
  ];

  /** Rows from the start of the previous period (a day of slack for timezones). */
  const since = (range: RangeKey) => new Date(`${addDays(periodOf(range, now(), timezone).prevFrom, -1)}T00:00:00Z`).toISOString();

  const api: Route[] = [
    {
      method: "GET",
      path: /^\/api\/stats$/,
      handle: async (_m, _b, url) => {
        const asked = url.searchParams.get("range") ?? "30d";
        if (!(asked in RANGES)) throw new BadRequest("range is one of 7d, 30d, 90d");
        const range = asked as RangeKey;
        const agents = await pc.agents();
        const crew = crewScopes(agents);
        const scopes = [{ scope: GLOBAL, name: "Everyone", avatar: null as string | null }, ...crew.map((c) => ({ scope: c.scope, name: c.name, avatar: c.avatar as string | null }))];
        const from = since(range);
        return computeStats({
          range,
          now: now(),
          tz: timezone,
          agents: agentInfos(agents),
          jobs: stats.jobs(from),
          runs: stats.runs(from),
          tasks: stats.tasks(),
          memories: memory.list(),
          budgets: memory.budgets(scopes.map((s) => s.scope)),
          scopes,
          coverage: { runsSyncedAt: stats.meta("runs_synced_at") ?? null, tasksSyncedAt: stats.meta("tasks_synced_at") ?? null, jobsReportedAt: stats.meta("jobs_reported_at") ?? null },
        });
      },
    },
    {
      // Weekly tokens per agent, for the sparkline on each Crew tile.
      method: "GET",
      path: /^\/api\/stats\/sparklines$/,
      handle: async () => {
        const at = now();
        const from = new Date(`${addDays(dayOf(new Date(at).toISOString(), timezone), -63)}T00:00:00Z`).toISOString();
        return weeklyTokens({ now: at, tz: timezone, runs: stats.runs(from), jobs: stats.jobs(from), tasks: stats.tasks() });
      },
    },
  ];

  return { internal, api };
}
