import type { Assignee, Card } from "./types";

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** How long something has been running: "40s", "12m", "1h 5m". */
export function elapsed(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** "Assistant", or "Codex" for "Engineer · Codex (gpt-5.5, high effort)". */
export function agentShort(agent: string): string {
  return agent.replace(/^Engineer · /, "").replace(/ \(.*\)$/, "");
}

export function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export const PRIORITY_NAMES: Record<string, string> = { critical: "Urgent", high: "High", medium: "Normal", low: "Low" };

/** Short names on cards: "Codex" for "Engineer · Codex". */
export function shortName(a: Assignee | undefined): string {
  if (!a) return "";
  if (a.kind === "me") return "You";
  return a.persona?.name ?? a.name.replace(/^Engineer · /, "");
}

export const STATUS_BADGE: Record<string, { text: string; tone: string } | undefined> = {
  // Only the status: whether an agent is running right now is the live badge (card.working).
  in_progress: { text: "In progress", tone: "progress" },
  in_review: { text: "Ready for review", tone: "review" },
  blocked: { text: "Blocked", tone: "blocked" },
  done: { text: "Done", tone: "done" },
  cancelled: { text: "Cancelled", tone: "cancelled" },
};

/** Labels that say where a task came from; the rest are shown as plain tags. */
export const SOURCE_NAMES: Record<string, string> = {
  "needs-response": "Reply",
  email: "Email",
  "meeting-action": "Meeting",
  todo: "Todo",
  engineer: "Code",
  "needs-review": "Review",
};

export function matches(card: Card, q: string): boolean {
  if (!q) return true;
  const hay = `${card.title} ${card.identifier} ${card.labels.map((l) => l.name).join(" ")}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

/** "Oct 15" for a YYYY-MM-DD date (as written) or an instant (local). */
export function shortDate(d: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00`) : new Date(d);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Thu, Oct 15, 07:00" for an instant, in the board's timezone. */
export function runTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
}

/** The date `n` days after a YYYY-MM-DD date. */
export function addDays(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** Today's YYYY-MM-DD in the board's timezone. */
export const todayIn = (timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/**
 * Snooze's presets from `today`: tomorrow, in 2 days, Friday (when it's later than that) and next
 * Monday, each date offered once.
 */
export function snoozeOptions(today: string): { label: string; date: string }[] {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const options = [
    { label: "Tomorrow", date: addDays(today, 1) },
    { label: "In 2 days", date: addDays(today, 2) },
    ...(dow >= 1 && dow <= 2 ? [{ label: "Later this week", date: addDays(today, 5 - dow) }] : []),
    { label: "Next week", date: addDays(today, (8 - dow) % 7 || 7) },
  ];
  return options.filter((o, i) => options.findIndex((x) => x.date === o.date) === i);
}
