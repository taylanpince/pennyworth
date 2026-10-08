// Scheduled moves and recurring tasks (D-25): the board side. The user (board UI), the Assistant
// (tasks bridge) and the runner (claims due runs) reach these through app.ts; every decision about
// dates and runs is made here, in code.
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";
import { BadRequest, displayText } from "./board.js";
import type { Issue, Label, Paperclip } from "./paperclip.js";
import { CadenceSchema, DATE, TIME, addDays, dayLabel, describeRule, localParts, makeRule, nextOccurrence, previousOccurrence, upcoming, type Rule } from "./recurrence.js";
import { BUCKETS, localDate, type Recurring, type RecurringRun, type Store } from "./store.js";

export const RECURRING_LABEL = "recurring";
const CLOSED = new Set(["done", "cancelled"]);
const MAX_AHEAD_DAYS = 366;
// A claimed run the runner didn't start within this long is handed out again, up to MAX_ATTEMPTS times.
const STALE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

export interface Ctx {
  me: string;
  labels: Label[];
}

// ------------------------------------------------------------------ scheduled moves

export const ScheduleSchema = z.union([
  z
    .object({
      date: z.string().regex(DATE, "date must be YYYY-MM-DD"),
      bucket: z.enum(BUCKETS).default("today"),
      position: z.enum(["top", "bottom"]).default("top"),
    })
    .strict(),
  z.object({ clear: z.literal(true) }).strict(),
]);

export interface ScheduleView {
  date: string;
  bucket: string;
  position: "top" | "bottom";
}

/** Schedule (or clear) a move. A date of today moves the task right away. */
export function scheduleMove(store: Store, issue: Issue, input: z.infer<typeof ScheduleSchema>, tz: string): { scheduled: ScheduleView | null; movedNow: boolean } {
  if ("clear" in input) {
    store.unschedule(issue.id);
    return { scheduled: null, movedNow: false };
  }
  if (CLOSED.has(issue.status)) throw new BadRequest("this task is closed");
  if (store.recurring(issue.id)) throw new BadRequest("this is a recurring task; its runs land in Today by themselves");
  const today = localDate(tz);
  if (input.date < today) throw new BadRequest(`${input.date} is in the past (today is ${today})`);
  if (input.date > addDays(today, MAX_AHEAD_DAYS)) throw new BadRequest("at most a year ahead");
  if (input.date === today) {
    store.move(issue.id, input.bucket, input.position);
    return { scheduled: null, movedNow: true };
  }
  store.schedule(issue.id, input.date, input.bucket, input.position);
  return { scheduled: { date: input.date, bucket: input.bucket, position: input.position }, movedNow: false };
}

// ------------------------------------------------------------------ recurring tasks

const REPO = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export const RecurringSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("set"),
      cadence: CadenceSchema,
      time: z.string().regex(TIME, "time must be HH:MM (24-hour)").default("07:00"),
      repos: z.array(z.string().trim().regex(REPO, "repos are owner/name or GitHub URLs")).max(30).default([]),
    })
    .strict(),
  z.object({ action: z.enum(["pause", "resume", "stop", "run_now"]) }).strict(),
]);

export interface RecurringView {
  summary: string;
  cadence: Rule["cadence"];
  time: string;
  repos: string[];
  paused: boolean;
  nextRun: string | null;
  upcoming: string[];
  runNowPending: boolean;
}

export function recurringView(r: Recurring, tz: string): RecurringView {
  const next = r.nextRun ? new Date(r.nextRun) : null;
  return {
    summary: describeRule(r.rule),
    cadence: r.rule.cadence,
    time: r.rule.time,
    repos: r.repos,
    paused: r.paused,
    nextRun: r.nextRun,
    upcoming: next ? [next, ...upcoming(r.rule, next, tz, 2)].map((t) => t.toISOString()) : [],
    runNowPending: r.manualAt !== null,
  };
}

const normalizeRepo = (s: string) => {
  const m = REPO.exec(s.trim())!;
  return `${m[1]}/${m[2]}`.toLowerCase();
};

const withLabel = (issue: Issue, label: Label | undefined, on: boolean) => {
  const ids = issue.labelIds ?? (issue.labels ?? []).map((l) => l.id);
  if (!label) return undefined;
  const has = ids.includes(label.id);
  if (has === on) return undefined;
  return on ? [...ids, label.id] : ids.filter((id) => id !== label.id);
};

/** Make a task recurring, change its rule, pause, resume, stop, or ask for a run now. */
export async function changeRecurring(pc: Paperclip, store: Store, ctx: Ctx, issue: Issue, input: z.infer<typeof RecurringSchema>, tz: string, log: Logger): Promise<RecurringView | null> {
  const existing = store.recurring(issue.id);
  const label = ctx.labels.find((l) => l.name === RECURRING_LABEL);
  const now = new Date();
  if (input.action === "set") {
    if (CLOSED.has(issue.status)) throw new BadRequest("this task is closed; reopen it first");
    if (issue.assigneeUserId !== ctx.me || issue.assigneeAgentId) throw new BadRequest("only your own tasks can be recurring (assign it to yourself first)");
    // Same cadence and time: keep the anchor, so an every-2-weeks rule doesn't shift.
    const same = existing && JSON.stringify(existing.rule.cadence) === JSON.stringify(input.cadence) && existing.rule.time === input.time;
    const rule = same ? existing.rule : makeRule(input.cadence, input.time, now, tz);
    const repos = [...new Set(input.repos.map(normalizeRepo))];
    store.setRecurring(issue.id, rule, repos, nextOccurrence(rule, now, tz).toISOString());
    store.unschedule(issue.id);
    const labelIds = withLabel(issue, label, true);
    if (labelIds) await pc.updateIssue(issue.id, { labelIds });
    if (!label) log.warn("label \"recurring\" missing in Paperclip (run scripts/paperclip-setup.mjs)");
    log.info({ issue: issue.identifier, rule: describeRule(rule), repos: repos.length }, "recurring task set");
    return recurringView(store.recurring(issue.id)!, tz);
  }
  if (!existing) throw new BadRequest("this task isn't recurring");
  if (input.action === "stop") {
    store.stopRecurring(issue.id);
    store.move(issue.id, "triage", "top");
    const labelIds = withLabel(issue, label, false);
    if (labelIds) await pc.updateIssue(issue.id, { labelIds });
    log.info({ issue: issue.identifier }, "recurring task stopped");
    return null;
  }
  if (input.action === "pause") store.setPaused(issue.id, true, null);
  if (input.action === "resume") store.setPaused(issue.id, false, nextOccurrence(existing.rule, now, tz).toISOString());
  if (input.action === "run_now") {
    if (existing.paused) throw new BadRequest("this recurring task is paused; resume it first");
    store.runNow(issue.id);
  }
  log.info({ issue: issue.identifier, action: input.action }, "recurring task changed");
  return recurringView(store.recurring(issue.id)!, tz);
}

// ------------------------------------------------------------------ runs (claimed by the runner)

/** What the runner needs to start one run. */
export interface ClaimedRun {
  definition: string;
  definitionId: string;
  title: string;
  output: string;
  outputId: string;
  occurrence: string;
  since: string;
  until: string;
  sinceLocal: string;
  untilLocal: string;
  timezone: string;
  previous: string | null;
  repos: string[];
  attempt: number;
}

const local = (iso: string, tz: string) => {
  const p = localParts(new Date(iso), tz);
  return `${p.date} ${p.time}`;
};
const marker = (definition: string, occurrence: string) => `recurring:${definition}:${occurrence}`;
const idempotencyKey = (m: string) => `pw-${createHash("sha256").update(m).digest("hex").slice(0, 32)}`;

/**
 * Hand the runner every run that is due: for each, the user's task for this period is created now
 * (top of Today, so a failed run still shows up) and the rule moves on. Runs claimed earlier but never
 * started are handed out again; after a few attempts their task says so.
 */
export async function claimDue(pc: Paperclip, store: Store, ctx: Ctx, tz: string, log: Logger): Promise<ClaimedRun[]> {
  const out: ClaimedRun[] = [];
  const now = new Date();
  const recurring = store.allRecurring();
  const definitions = new Map<string, Issue>();
  const definition = async (id: string) => {
    if (!definitions.has(id)) definitions.set(id, await pc.issue(id));
    return definitions.get(id)!;
  };

  for (const r of store.dueRecurring(now.toISOString())) {
    const issue = await definition(r.issueId);
    if (CLOSED.has(issue.status)) {
      // Closing the definition ends it; the label stays as a record.
      store.stopRecurring(r.issueId);
      log.info({ issue: issue.identifier }, "recurring task closed: stopped");
      continue;
    }
    // A scheduled run that is due wins over "run now" (it covers the same need, and its window).
    const manual = r.manualAt !== null && !(r.nextRun !== null && r.nextRun <= now.toISOString());
    const until = manual ? now : previousOccurrence(r.rule, now, tz) ?? new Date(r.nextRun!);
    const occurrence = (({ date, time }) => `${date}T${time}`)(localParts(until, tz));
    const nextRun = nextOccurrence(r.rule, now, tz).toISOString();
    if (store.run(r.issueId, occurrence)) {
      // Already ran for this occurrence (a "run now" in the same minute): just move on.
      store.skipTo(r.issueId, nextRun);
      continue;
    }
    // A scheduled run covers the time since the last scheduled one. "Run now" is an extra: one full
    // period up to now, and the next scheduled run still covers its whole window.
    const since = manual ? new Date(until.getTime() - periodMs(r.rule, until, tz)) : r.lastUntil && r.lastUntil < until.toISOString() ? new Date(r.lastUntil) : previousOccurrence(r.rule, new Date(until.getTime() - 60_000), tz) ?? new Date(until.getTime() - 7 * 86_400_000);
    const m = marker(issue.identifier, occurrence);
    const todo = ctx.labels.find((l) => l.name === "todo");
    const sinceLocal = local(since.toISOString(), tz);
    const untilLocal = local(until.toISOString(), tz);
    const output = await pc.createIssue({
      title: `${issue.title} — ${dayLabel(until, tz)}`.slice(0, 200),
      description: `_The Assistant is preparing this from ${issue.identifier} (${describeRule(r.rule)}), covering ${sinceLocal} to ${untilLocal}._\n\n<!-- source:${m} -->`,
      status: "todo",
      priority: issue.priority,
      assigneeUserId: ctx.me,
      ...(todo ? { labelIds: [todo.id] } : {}),
      idempotencyKey: idempotencyKey(m),
      allowDuplicate: true,
    });
    store.move(output.id, "today", "top");
    const run = {
      issueId: r.issueId,
      occurrence,
      outputId: output.id,
      outputIdentifier: output.identifier,
      since: since.toISOString(),
      until: until.toISOString(),
      previous: store.lastOutput(r.issueId) ?? null,
      claimedAt: now.toISOString(),
    };
    store.claimRun(run, nextRun, !manual);
    log.info({ issue: issue.identifier, output: output.identifier, occurrence, manual }, "recurring run claimed");
    out.push(toClaimed({ ...run, state: "claimed", attempts: 1 }, issue, r, tz));
  }

  for (const run of store.retryRuns(STALE_MS, MAX_ATTEMPTS)) {
    const r = recurring.get(run.issueId);
    if (!r) continue;
    log.warn({ output: run.outputIdentifier, attempt: run.attempts }, "recurring run handed out again");
    out.push(toClaimed(run, await definition(run.issueId), r, tz));
  }
  for (const run of store.abandonedRuns(STALE_MS, MAX_ATTEMPTS)) {
    store.setRunState(run.issueId, run.occurrence, "failed");
    await pc.addComment(run.outputId, `This run couldn't be started after ${run.attempts} attempts, so there's no draft. Check the runner (\`journalctl --user -u pennyworth-runner\`), then use **Run now** on the recurring task.`).catch(() => {});
    log.error({ output: run.outputIdentifier }, "recurring run abandoned");
  }
  return out;
}

/** The length of the rule's period around `at`: from the latest occurrence before it to the next one. */
function periodMs(rule: Rule, at: Date, tz: string): number {
  const prev = previousOccurrence(rule, at, tz);
  return prev ? nextOccurrence(rule, prev, tz).getTime() - prev.getTime() : 7 * 86_400_000;
}

const toClaimed = (run: RecurringRun, issue: Issue, r: Recurring, tz: string): ClaimedRun => ({
  definition: issue.identifier,
  definitionId: issue.id,
  title: displayText(issue.title),
  output: run.outputIdentifier,
  outputId: run.outputId,
  occurrence: run.occurrence,
  since: run.since,
  until: run.until,
  sinceLocal: local(run.since, tz),
  untilLocal: local(run.until, tz),
  timezone: tz,
  previous: run.previous,
  repos: r.repos,
  attempt: run.attempts,
});

export const RunStateSchema = z.object({ state: z.enum(["started", "failed"]) }).strict();
