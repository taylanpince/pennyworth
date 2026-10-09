// Recurring tasks (D-25): when a rule fires, in the user's timezone. Pure functions (unit-tested).
// Cron can't say "first Monday of the month" (day-of-month and weekday are OR'ed) and doesn't
// catch up after the laptop slept, so the board computes occurrences itself.
import { z } from "zod";

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const weekday = z.enum(WEEKDAYS);
const interval = z.number().int().min(1).max(12).default(1);

export const CadenceSchema = z.discriminatedUnion("kind", [
  /** Every `interval` weeks on a weekday. */
  z.object({ kind: z.literal("weekly"), weekday, interval }).strict(),
  /** Every `interval` months on a day of the month (clamped to short months), or the last day. */
  z.object({ kind: z.literal("monthly_day"), day: z.union([z.number().int().min(1).max(31), z.literal("last")]), interval }).strict(),
  /** Every `interval` months on the nth (or last) weekday, e.g. the first Monday. */
  z.object({ kind: z.literal("monthly_weekday"), nth: z.union([z.number().int().min(1).max(4), z.literal("last")]), weekday, interval }).strict(),
]);
export type Cadence = z.infer<typeof CadenceSchema>;

export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A stored rule: the cadence, the local time it runs, and the first occurrence (for every-N intervals). */
export interface Rule {
  cadence: Cadence;
  time: string;
  anchor: string;
}

// ------------------------------------------------------------------ calendar dates (YYYY-MM-DD)

const toUtc = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
};
const fromUtc = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (date: string, n: number) => fromUtc(new Date(toUtc(date).getTime() + n * 86_400_000));
const isoWeekday = (date: string) => ((toUtc(date).getUTCDay() + 6) % 7) + 1; // 1 = Monday
export const weekdayOf = (date: string): Weekday => WEEKDAYS[isoWeekday(date) - 1]!;
/** The first workday after `date` (Friday → Monday with the default Monday to Friday week). */
export function nextWorkday(date: string, workdays: readonly Weekday[]): string {
  for (let n = 1; n <= 7; n++) if (workdays.includes(weekdayOf(addDays(date, n)))) return addDays(date, n);
  return addDays(date, 1);
}
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based
const dayDiff = (a: string, b: string) => Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Whether a local date matches the cadence, ignoring the interval. */
function matchesDay(c: Cadence, date: string): boolean {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  if (c.kind === "weekly") return isoWeekday(date) === WEEKDAYS.indexOf(c.weekday) + 1;
  const last = daysInMonth(y, m);
  if (c.kind === "monthly_day") return d === (c.day === "last" ? last : Math.min(c.day, last));
  if (isoWeekday(date) !== WEEKDAYS.indexOf(c.weekday) + 1) return false;
  return c.nth === "last" ? d + 7 > last : Math.ceil(d / 7) === c.nth;
}

/** Whether a local date is an occurrence of the rule (interval counted from the anchor). */
export function isOccurrence(rule: Rule, date: string): boolean {
  const c = rule.cadence;
  if (!matchesDay(c, date)) return false;
  if (c.interval === 1) return true;
  if (c.kind === "weekly") return mod(Math.floor(dayDiff(rule.anchor, date) / 7), c.interval) === 0;
  return mod(monthIndex(date) - monthIndex(rule.anchor), c.interval) === 0;
}

// ------------------------------------------------------------------ instants in a timezone

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(t: Date, tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, seconds: Number(p.second) };
}

const offsetAt = (t: number, tz: string) => {
  const p = parts(new Date(t), tz);
  return toUtc(p.date).getTime() + (Number(p.time.slice(0, 2)) * 60 + Number(p.time.slice(3))) * 60_000 + p.seconds * 1000 - Math.floor(t / 1000) * 1000;
};

/** The instant of a local date and time in a timezone (DST-aware). */
export function zonedInstant(date: string, time: string, tz: string): Date {
  const guess = toUtc(date).getTime() + (Number(time.slice(0, 2)) * 60 + Number(time.slice(3))) * 60_000;
  const first = offsetAt(guess, tz);
  let t = guess - first;
  const second = offsetAt(t, tz);
  if (second !== first) t = guess - second;
  return new Date(t);
}

/** Local date and time ("2026-10-12", "07:00") of an instant. */
export const localParts = (t: Date, tz: string) => {
  const p = parts(t, tz);
  return { date: p.date, time: p.time };
};

// ------------------------------------------------------------------ occurrences

// Long enough for an every-12-months rule plus a short month.
const HORIZON_DAYS = 12 * 31 + 62;

/** The first occurrence strictly after `after`. */
export function nextOccurrence(rule: Rule, after: Date, tz: string): Date {
  const start = localParts(after, tz).date;
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const date = addDays(start, i);
    if (!isOccurrence(rule, date)) continue;
    const at = zonedInstant(date, rule.time, tz);
    if (at > after) return at;
  }
  throw new Error("no occurrence within a year");
}

/** The latest occurrence at or before `at` (within the horizon). */
export function previousOccurrence(rule: Rule, at: Date, tz: string): Date | undefined {
  const start = localParts(at, tz).date;
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const date = addDays(start, -i);
    if (!isOccurrence(rule, date)) continue;
    const t = zonedInstant(date, rule.time, tz);
    if (t <= at) return t;
  }
  return undefined;
}

/** The next `n` occurrences after `after`. */
export function upcoming(rule: Rule, after: Date, tz: string, n = 3): Date[] {
  const out: Date[] = [];
  let t = after;
  while (out.length < n) out.push((t = nextOccurrence(rule, t, tz)));
  return out;
}

/** A new rule: the anchor is the first occurrence from today (ignoring the interval). */
export function makeRule(cadence: Cadence, time: string, now: Date, tz: string): Rule {
  const probe: Rule = { cadence: { ...cadence, interval: 1 }, time, anchor: localParts(now, tz).date };
  const first = nextOccurrence(probe, now, tz);
  return { cadence, time, anchor: localParts(first, tz).date };
}

// ------------------------------------------------------------------ words

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const NTH = ["first", "second", "third", "fourth"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Every Monday at 07:00", "Every 3 months on the 1st at 07:00", "Monthly on the first Monday at 07:00". */
export function describeRule(rule: Rule): string {
  const c = rule.cadence;
  const at = `at ${rule.time}`;
  if (c.kind === "weekly") return c.interval === 1 ? `Every ${cap(c.weekday)} ${at}` : `Every ${c.interval} weeks on ${cap(c.weekday)} ${at}`;
  const every = c.interval === 1 ? "Monthly" : `Every ${c.interval} months`;
  if (c.kind === "monthly_day") return `${every} on the ${c.day === "last" ? "last day" : ordinal(c.day)} ${at}`;
  return `${every} on the ${c.nth === "last" ? "last" : NTH[c.nth - 1]} ${cap(c.weekday)} ${at}`;
}

/** "Mon, Oct 12, 2026" in the user's timezone. */
export const dayLabel = (t: Date, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(t);
