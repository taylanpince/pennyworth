import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { RecurringSchema, ScheduleSchema, changeRecurring, claimDue, scheduleMove } from "../src/automation.js";
import type { Issue, Label, Paperclip } from "../src/paperclip.js";
import { describeRule, isOccurrence, makeRule, nextOccurrence, previousOccurrence, upcoming, zonedInstant, type Cadence, type Rule } from "../src/recurrence.js";
import { Store, localDate } from "../src/store.js";

const TZ = "Europe/Madrid";
const log = pino({ level: "silent" });
const rule = (cadence: Cadence, anchor = "2026-10-01", time = "07:00"): Rule => ({ cadence, time, anchor });
const iso = (s: string) => new Date(s).toISOString();

describe("recurrence", () => {
  it("finds the next weekly run in the user's timezone, across the DST change", () => {
    const r = rule({ kind: "weekly", weekday: "monday", interval: 1 });
    // Thursday 2026-10-08 → Monday 2026-10-12 07:00 CEST (UTC+2).
    expect(nextOccurrence(r, new Date("2026-10-08T10:00:00Z"), TZ).toISOString()).toBe(iso("2026-10-12T05:00:00Z"));
    // Monday 2026-10-26 is after the switch to CET (UTC+1).
    expect(nextOccurrence(r, new Date("2026-10-20T10:00:00Z"), TZ).toISOString()).toBe(iso("2026-10-26T06:00:00Z"));
    // Exactly at a run: the next one is a week later.
    expect(nextOccurrence(r, new Date("2026-10-12T05:00:00Z"), TZ).toISOString()).toBe(iso("2026-10-19T05:00:00Z"));
  });

  it("clamps day 31 to short months and handles the last day", () => {
    const r31 = rule({ kind: "monthly_day", day: 31, interval: 1 });
    expect(isOccurrence(r31, "2027-02-28")).toBe(true);
    expect(isOccurrence(r31, "2026-10-31")).toBe(true);
    expect(isOccurrence(r31, "2026-11-30")).toBe(true);
    const last = rule({ kind: "monthly_day", day: "last", interval: 1 });
    expect(isOccurrence(last, "2028-02-29")).toBe(true);
    expect(isOccurrence(last, "2028-02-28")).toBe(false);
  });

  it("finds the nth and the last weekday of a month", () => {
    const first = rule({ kind: "monthly_weekday", nth: 1, weekday: "monday", interval: 1 });
    expect(nextOccurrence(first, new Date("2026-10-08T00:00:00Z"), TZ).toISOString()).toBe(iso("2026-11-02T06:00:00Z"));
    const lastFriday = rule({ kind: "monthly_weekday", nth: "last", weekday: "friday", interval: 1 });
    expect(isOccurrence(lastFriday, "2026-10-30")).toBe(true);
    expect(isOccurrence(lastFriday, "2026-10-23")).toBe(false);
  });

  it("counts every-N intervals from the anchor", () => {
    const fortnight = rule({ kind: "weekly", weekday: "monday", interval: 2 }, "2026-10-12");
    expect(upcoming(fortnight, new Date("2026-10-08T00:00:00Z"), TZ).map((t) => t.toISOString().slice(0, 10))).toEqual(["2026-10-12", "2026-10-26", "2026-11-09"]);
    expect(isOccurrence(fortnight, "2026-10-05")).toBe(false);
    expect(isOccurrence(fortnight, "2026-09-28")).toBe(true);
    const quarterly = rule({ kind: "monthly_day", day: 1, interval: 3 }, "2026-11-01");
    expect(upcoming(quarterly, new Date("2026-10-08T00:00:00Z"), TZ).map((t) => t.toISOString().slice(0, 10))).toEqual(["2026-11-01", "2027-02-01", "2027-05-01"]);
  });

  it("anchors a new rule on its first run", () => {
    const r = makeRule({ kind: "weekly", weekday: "monday", interval: 2 }, "07:00", new Date("2026-10-08T10:00:00Z"), TZ);
    expect(r.anchor).toBe("2026-10-12");
  });

  it("finds the latest run at or before a time", () => {
    const r = rule({ kind: "weekly", weekday: "monday", interval: 1 });
    expect(previousOccurrence(r, new Date("2026-10-14T00:00:00Z"), TZ)?.toISOString()).toBe(iso("2026-10-12T05:00:00Z"));
    expect(previousOccurrence(r, new Date("2026-10-12T05:00:00Z"), TZ)?.toISOString()).toBe(iso("2026-10-12T05:00:00Z"));
    expect(previousOccurrence(r, new Date("2026-10-12T04:59:00Z"), TZ)?.toISOString()).toBe(iso("2026-10-05T05:00:00Z"));
  });

  it("puts rules into words", () => {
    expect(describeRule(rule({ kind: "weekly", weekday: "monday", interval: 1 }))).toBe("Every Monday at 07:00");
    expect(describeRule(rule({ kind: "weekly", weekday: "friday", interval: 2 }))).toBe("Every 2 weeks on Friday at 07:00");
    expect(describeRule(rule({ kind: "monthly_day", day: 3, interval: 1 }))).toBe("Monthly on the 3rd at 07:00");
    expect(describeRule(rule({ kind: "monthly_day", day: "last", interval: 3 }))).toBe("Every 3 months on the last day at 07:00");
    expect(describeRule(rule({ kind: "monthly_weekday", nth: 1, weekday: "monday", interval: 1 }))).toBe("Monthly on the first Monday at 07:00");
  });

  it("maps local times to instants", () => {
    expect(zonedInstant("2026-07-01", "07:00", TZ).toISOString()).toBe(iso("2026-07-01T05:00:00Z"));
    expect(zonedInstant("2026-12-01", "07:00", TZ).toISOString()).toBe(iso("2026-12-01T06:00:00Z"));
    expect(zonedInstant("2026-10-12", "09:30", "America/Toronto").toISOString()).toBe(iso("2026-10-12T13:30:00Z"));
  });
});

describe("scheduled moves", () => {
  it("moves the task on its date, on top, and only once", () => {
    const s = new Store(":memory:");
    s.move("a", "today");
    s.move("b", "later");
    s.schedule("b", "2026-10-15", "today", "top");
    expect(s.applySchedules("2026-10-14")).toEqual([]);
    expect(s.placements().get("b")?.bucket).toBe("later");
    expect(s.applySchedules("2026-10-15")).toEqual(["b"]);
    const p = s.placements();
    expect(p.get("b")!.bucket).toBe("today");
    expect(p.get("b")!.rank).toBeLessThan(p.get("a")!.rank);
    expect(s.schedules().size).toBe(0);
  });

  it("catches up after downtime", () => {
    const s = new Store(":memory:");
    s.schedule("b", "2026-10-10", "today");
    expect(s.applySchedules("2026-10-15")).toEqual(["b"]);
  });

  it("a move by hand replaces the scheduled one; ranking within the column doesn't", () => {
    const s = new Store(":memory:");
    s.move("b", "later");
    s.move("c", "later");
    s.schedule("b", "2026-10-15", "today");
    s.setOrder("later", ["c", "b"]);
    expect(s.schedules().has("b")).toBe(true);
    s.setOrder("tomorrow", ["b"]);
    expect(s.schedules().has("b")).toBe(false);
    s.schedule("c", "2026-10-15", "today");
    s.move("c", "backlog");
    expect(s.schedules().has("c")).toBe(false);
  });

  it("validates dates and moves right away when the date is today", () => {
    const s = new Store(":memory:");
    const today = localDate(TZ);
    const parse = (b: unknown) => ScheduleSchema.parse(b);
    expect(() => scheduleMove(s, issue(), parse({ date: "2020-01-01" }), TZ)).toThrow(/in the past/);
    expect(() => scheduleMove(s, issue(), parse({ date: "2099-01-01" }), TZ)).toThrow(/a year/);
    expect(scheduleMove(s, issue(), parse({ date: today }), TZ)).toEqual({ scheduled: null, movedNow: true });
    expect(s.placements().get(issue().id)?.bucket).toBe("today");
    expect(() => scheduleMove(s, issue({ status: "done" }), parse({ date: today }), TZ)).toThrow(/closed/);
    expect(() => ScheduleSchema.parse({ date: "next tuesday" })).toThrow();
  });
});

// ------------------------------------------------------------------ recurring runs

const ME = "user-1";
const labels: Label[] = [
  { id: "00000000-0000-0000-0000-00000000001a", name: "todo", color: "#0891b2" },
  { id: "00000000-0000-0000-0000-00000000001b", name: "recurring", color: "#0d9488" },
];
const ctx = { me: ME, labels };

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    identifier: "PEN-1",
    title: "Weekly team update",
    description: "Channels: #team. Repos: acme/api.",
    status: "todo",
    priority: "high",
    assigneeUserId: ME,
    assigneeAgentId: null,
    assigneeAdapterOverrides: null,
    labels: [],
    labelIds: [],
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...over,
  };
}

function fakePaperclip(def: Issue) {
  let n = 100;
  const created: Record<string, unknown>[] = [];
  const pc = {
    issue: vi.fn(async () => def),
    updateIssue: vi.fn(async (_id: string, body: Record<string, unknown>) => ({ ...def, ...body })),
    addComment: vi.fn(async () => ({ id: "c" })),
    createIssue: vi.fn(async (body: Record<string, unknown>) => {
      created.push(body);
      n++;
      return { ...issue(), id: `22222222-2222-2222-2222-222222222${n}`, identifier: `PEN-${n}`, title: String(body.title) };
    }),
  };
  return { pc: pc as unknown as Paperclip & typeof pc, created };
}

describe("recurring tasks", () => {
  const set = RecurringSchema.parse({ action: "set", cadence: { kind: "weekly", weekday: "monday" }, repos: ["https://github.com/Acme/API", "acme/api", "acme/web"] });

  it("makes your own task recurring, labels it, and shows the next runs", async () => {
    const s = new Store(":memory:");
    const def = issue();
    const { pc } = fakePaperclip(def);
    const view = await changeRecurring(pc, s, ctx, def, set, TZ, log);
    expect(view).toMatchObject({ summary: "Every Monday at 07:00", repos: ["acme/api", "acme/web"], paused: false });
    expect(view!.upcoming).toHaveLength(3);
    expect(pc.updateIssue).toHaveBeenCalledWith(def.id, { labelIds: [labels[1]!.id] });
    await expect(changeRecurring(pc, s, ctx, issue({ assigneeUserId: null, assigneeAgentId: "agent" }), set, TZ, log)).rejects.toThrow(/your own tasks/);
  });

  it("pauses, resumes and stops", async () => {
    const s = new Store(":memory:");
    const def = issue({ labelIds: [labels[1]!.id] });
    const { pc } = fakePaperclip(def);
    await changeRecurring(pc, s, ctx, def, set, TZ, log);
    expect((await changeRecurring(pc, s, ctx, def, { action: "pause" }, TZ, log))!.nextRun).toBeNull();
    await expect(changeRecurring(pc, s, ctx, def, { action: "run_now" }, TZ, log)).rejects.toThrow(/paused/);
    expect((await changeRecurring(pc, s, ctx, def, { action: "resume" }, TZ, log))!.nextRun).not.toBeNull();
    expect(await changeRecurring(pc, s, ctx, def, { action: "stop" }, TZ, log)).toBeNull();
    expect(s.recurring(def.id)).toBeUndefined();
    expect(s.placements().get(def.id)?.bucket).toBe("triage");
    expect(pc.updateIssue).toHaveBeenLastCalledWith(def.id, { labelIds: [] });
  });

  it("claims a due run once: your task for the period lands on top of Today, and the rule moves on", async () => {
    const s = new Store(":memory:");
    const def = issue();
    const { pc, created } = fakePaperclip(def);
    s.move("other", "today");
    // A weekly Monday rule whose run was due last Monday.
    const r = rule({ kind: "weekly", weekday: "monday", interval: 1 });
    const due = previousOccurrence(r, new Date(), TZ)!;
    s.setRecurring(def.id, r, ["acme/api"], due.toISOString());

    const [run, ...rest] = await claimDue(pc, s, ctx, TZ, log);
    expect(rest).toEqual([]);
    expect(run).toMatchObject({ definition: "PEN-1", output: "PEN-101", repos: ["acme/api"], previous: null, timezone: TZ, attempt: 1 });
    expect(new Date(run!.until).getTime()).toBe(due.getTime());
    expect(new Date(run!.since).getTime()).toBe(due.getTime() - 7 * 86_400_000);
    expect(created[0]).toMatchObject({ assigneeUserId: ME, status: "todo", priority: "high", labelIds: [labels[0]!.id] });
    expect(String(created[0]!.description)).toContain(`<!-- source:recurring:PEN-1:${run!.occurrence} -->`);
    const p = s.placements();
    expect(p.get(run!.outputId)!.bucket).toBe("today");
    expect(p.get(run!.outputId)!.rank).toBeLessThan(p.get("other")!.rank);
    expect(s.recurring(def.id)!.nextRun! > new Date().toISOString()).toBe(true);

    // Nothing more is due. "Run now" covers one full period up to now and links to the last run;
    // the next scheduled run still starts where the last scheduled one ended.
    expect(await claimDue(pc, s, ctx, TZ, log)).toEqual([]);
    s.runNow(def.id);
    const [manual] = await claimDue(pc, s, ctx, TZ, log);
    expect(manual).toMatchObject({ output: "PEN-102", previous: "PEN-101" });
    const span = Date.parse(manual!.until) - Date.parse(manual!.since);
    expect(span).toBeGreaterThanOrEqual(7 * 86_400_000 - 3_600_000);
    expect(span).toBeLessThanOrEqual(7 * 86_400_000 + 3_600_000);
    expect(s.recurring(def.id)!.manualAt).toBeNull();
    expect(s.recurring(def.id)!.lastUntil).toBe(run!.until);
  });

  it("hands out a run again if it wasn't started, then gives up with a comment on your task", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const s = new Store(":memory:");
      const def = issue();
      const { pc } = fakePaperclip(def);
      s.setRecurring(def.id, rule({ kind: "weekly", weekday: "monday", interval: 1 }), [], new Date(Date.now() - 1000).toISOString());
      const [first] = await claimDue(pc, s, ctx, TZ, log);
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect((await claimDue(pc, s, ctx, TZ, log)).map((r) => [r.output, r.attempt])).toEqual([[first!.output, 2]]);
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect((await claimDue(pc, s, ctx, TZ, log)).map((r) => r.attempt)).toEqual([3]);
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect(await claimDue(pc, s, ctx, TZ, log)).toEqual([]);
      expect(pc.addComment).toHaveBeenCalledWith(first!.outputId, expect.stringContaining("couldn't be started"));
      expect(s.run(def.id, first!.occurrence)!.state).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("started runs aren't handed out again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const s = new Store(":memory:");
      const def = issue();
      const { pc } = fakePaperclip(def);
      s.setRecurring(def.id, rule({ kind: "weekly", weekday: "monday", interval: 1 }), [], new Date(Date.now() - 1000).toISOString());
      const [first] = await claimDue(pc, s, ctx, TZ, log);
      s.setRunState(def.id, first!.occurrence, "started");
      vi.setSystemTime(Date.now() + 30 * 60_000);
      expect(await claimDue(pc, s, ctx, TZ, log)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closing the definition stops it", async () => {
    const s = new Store(":memory:");
    const def = issue({ status: "done" });
    const { pc } = fakePaperclip(def);
    s.setRecurring(def.id, rule({ kind: "weekly", weekday: "monday", interval: 1 }), [], new Date(Date.now() - 1000).toISOString());
    expect(await claimDue(pc, s, ctx, TZ, log)).toEqual([]);
    expect(s.recurring(def.id)).toBeUndefined();
    expect(pc.createIssue).not.toHaveBeenCalled();
  });

  it("rejects cadences it can't run", () => {
    expect(() => RecurringSchema.parse({ action: "set", cadence: { kind: "weekly", weekday: "funday" } })).toThrow();
    expect(() => RecurringSchema.parse({ action: "set", cadence: { kind: "monthly_weekday", nth: 5, weekday: "monday" } })).toThrow();
    expect(() => RecurringSchema.parse({ action: "set", cadence: { kind: "monthly_day", day: 1 }, time: "7am" })).toThrow();
    expect(() => RecurringSchema.parse({ action: "set", cadence: { kind: "weekly", weekday: "monday" }, repos: ["not a repo"] })).toThrow();
  });
});
