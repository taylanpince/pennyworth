// The supervisor (D-76): an agent whose one job is the board. She reads every column and assigns the crew
// to what's likely to come to something; the rules on what she may assign are here, in code, not in her
// prompt. Her parts carry SUPERVISOR_MARKER: the runner starts an Engineer's part from it as her request,
// not the user's, so writes beyond the task still need the user's words (and on a task made from other
// people's words, so does a draft PR).
import { z } from "zod";
import type { Assignee, Card } from "./board.js";
import type { Issue } from "./paperclip.js";
import { displayText } from "./board.js";
import type { Bucket, Store } from "./store.js";

export const SUPERVISOR_MARKER = "<!-- pennyworth-supervisor -->";

export const SupervisorAssignSchema = z
  .object({
    task: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/),
    agent: z.string().min(1).max(40),
    instructions: z.string().trim().min(20).max(4000),
    why: z.string().trim().min(10).max(500),
  })
  .strict();

/** Labels that keep a task from the supervisor: the user's reviews, the brief, recurring definitions, hands off. */
const SKIP = new Set(["needs-review", "recurring", "daily-brief", "hands-off", "system-error"]);
/** At most this many assignments in a pass (two hours) and in a day. */
export const PER_PASS = 5;
export const PER_DAY = 15;
const HOUR = 3_600_000;

export interface SupervisorAssignment {
  task: string;
  part: string;
  partId: string;
  agent: string;
  at: string;
}

export function supervisorAssignments(store: Store): SupervisorAssignment[] {
  return JSON.parse(store.meta("supervisor:assignments") ?? "[]") as SupervisorAssignment[];
}

export function recordSupervisorAssignment(store: Store, a: SupervisorAssignment): void {
  store.setMeta("supervisor:assignments", JSON.stringify([...supervisorAssignments(store), a].slice(-200)));
}

/** Her part's description: her instructions, and why she picked the task, for the agent and the user. */
export function supervisorInstructions(instructions: string, why: string): string {
  return `${displayText(instructions)}\n\n_Assigned by the supervisor: ${displayText(why).replace(/\s+/g, " ")}_`;
}

/** Why an assignment can't be made, or undefined when it can. */
export function supervisorRefusal({ issue, agentName, assignees, parts, recent, now = Date.now() }: { issue: Issue; agentName: string; assignees: Assignee[]; parts: Issue[]; recent: SupervisorAssignment[]; now?: number }): string | undefined {
  const agent = assignees.find((a) => a.kind !== "me" && a.persona?.name.toLowerCase() === agentName.toLowerCase());
  if (!agent) return `no crew member is called ${agentName}: ${assignees.flatMap((a) => (a.kind !== "me" && a.persona ? [a.persona.name] : [])).join(", ")}`;
  if (sourceOf(issue) === "supervisor") return `${issue.identifier} is your own report`;
  const label = (issue.labels ?? []).find((l) => SKIP.has(l.name));
  if (label) return `${issue.identifier} has the ${label.name} label: leave it to the user`;
  if (issue.parentId && parts.some((p) => p.assigneeAgentId)) return `${issue.identifier} is a subtask with crew already`;
  const own = parts.find((p) => p.assigneeAgentId === agent.key && !["done", "cancelled"].includes(p.status));
  if (own) return `${agent.persona!.name} is already on ${issue.identifier} (${own.identifier})`;
  const before = recent.find((r) => r.task === issue.identifier && r.agent.toLowerCase() === agent.persona!.name.toLowerCase());
  if (before) return `you assigned ${agent.persona!.name} to ${issue.identifier} before (${before.at.slice(0, 10)}): once per task and crew member`;
  const pass = recent.filter((r) => now - Date.parse(r.at) < 2 * HOUR).length;
  if (pass >= PER_PASS) return `${PER_PASS} assignments in two hours is the limit: leave the rest for the next pass`;
  if (recent.filter((r) => now - Date.parse(r.at) < 24 * HOUR).length >= PER_DAY) return `${PER_DAY} assignments a day is the limit`;
  return undefined;
}

/** Where a task came from: a source marker's kind (slack, telegram, email, meeting, primer…), the user, or an agent. */
export function sourceOf(issue: Issue): string {
  const m = /<!-- (?:source:)+([a-z]+)/.exec(issue.description ?? "");
  return m ? m[1]! : issue.createdByAgentId ? "agent" : "you";
}

const DAY = 24 * HOUR;
const age = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / DAY));

/** The board for her: each column in the user's order, each card with what she needs to judge it. */
export function supervisorView(buckets: Record<Bucket, Card[]>, issues: Map<string, Issue>, now = Date.now()) {
  const order: Bucket[] = ["today", "tomorrow", "triage", "backlog", "later"];
  return order.map((bucket) => ({
    column: bucket,
    tasks: (buckets[bucket] ?? []).map((c) => {
      const i = issues.get(c.id);
      return {
        task: c.identifier,
        title: c.title,
        status: c.status,
        priority: c.priority,
        labels: c.labels.map((l) => l.name),
        from: i ? sourceOf(i) : "unknown",
        age_days: age(c.createdAt, now),
        idle_days: age(c.activityAt, now),
        ...(c.carried ? { carried_days: c.carried } : {}),
        crew: (c.crew ?? []).map((m) => ({ agent: m.agent, state: m.state })),
        ...(c.subtasks ? { subtasks: c.subtasks } : {}),
        description: displayText(i?.description).slice(0, 700),
      };
    }),
  }));
}
