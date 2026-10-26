// The crew on a task (D-45): agents work on the user's task in child issues, one per agent (several
// for a fan-out, D-24). The board folds them into the parent card. Pure functions; I/O is in app.ts.
import type { Assignee } from "./board.js";
import type { Issue } from "./paperclip.js";

export type CrewState = "needs" | "failed" | "proposed" | "working" | "queued" | "done";

/** One agent on a task: its state, and the issues it works in (one, or a fan-out's many). */
export interface CrewMember {
  agent: string;
  state: CrewState;
  issues: { id: string; identifier: string; title: string; state: CrewState }[];
  /** A fan-out: how many of its issues have finished. */
  finished?: number;
  since?: string | null;
}

/** What needs the user most, first: an agent waiting on them, then one that's stuck, then one to approve. */
const URGENCY: CrewState[] = ["needs", "failed", "proposed", "working", "queued", "done"];
export const mostUrgent = (states: CrewState[]): CrewState => URGENCY.find((s) => states.includes(s)) ?? "done";

/** Runner job results that mean the agent got stuck (the runner's `jobs.status`). */
const STUCK = new Set(["failed", "timeout", "incomplete"]);

export interface CrewInput {
  assignees: Assignee[];
  /** Read markers per issue, and the default for issues never opened. */
  seen: (issueId: string) => string;
  /** Agents working on or queued for an issue, by identifier (activity.ts). */
  working: Map<string, { since: string | null; queued: boolean }>;
  /** The runner's latest job result per identifier. */
  jobs: Map<string, string>;
}

const crewAgent = (i: Issue, list: Assignee[]) => list.find((a) => a.kind !== "me" && a.key === i.assigneeAgentId);

/**
 * The issues folded into another card: open or closed children of a task the board shows, assigned to a
 * crew agent, keyed to the top-most shown ancestor. Anything else (children assigned to the user, or
 * whose parent isn't shown, e.g. closed long ago) stays a card of its own.
 */
export function foldedChildren(issues: Issue[], assignees: Assignee[]): Map<string, string> {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const out = new Map<string, string>();
  for (const i of issues) {
    if (!i.parentId || !crewAgent(i, assignees)) continue;
    let top = byId.get(i.parentId);
    for (let n = 0; top?.parentId && byId.has(top.parentId) && n < 10; n++) top = byId.get(top.parentId);
    if (top && top.id !== i.id) out.set(i.id, top.id);
  }
  return out;
}

/** Where one issue stands for its agent. */
export function issueState(i: Issue, agent: Assignee, input: CrewInput): CrewState {
  const w = input.working.get(i.identifier);
  if (w) return w.queued ? "queued" : "working";
  const closed = i.status === "done" || i.status === "cancelled";
  // An Engineer task the Assistant made waits for the user's go-ahead (D-24): the runner starts it on approval.
  if (!closed && i.status === "todo" && agent.kind === "engineer" && i.createdByAgentId && !i.createdByUserId) return "proposed";
  const job = input.jobs.get(i.identifier);
  if (!closed && job && STUCK.has(job)) return "failed";
  // Something new to read is the user's turn, even on a part that's closed.
  const activityAt = i.lastActivityAt ?? i.updatedAt;
  if (activityAt > input.seen(i.id)) return "needs";
  // Assigned and not picked up yet (nothing happened since it was made): the runner polls, Paperclip wakes the Assistant.
  if (!closed && i.status === "todo" && !job && Date.parse(activityAt) - Date.parse(i.createdAt) < 60_000) return "queued";
  return "done";
}

/**
 * The crew of one card: the card's own agent when it's assigned to one (tasks from before D-45), then
 * its children grouped by agent, the Assistant first, then in the order they joined.
 */
export function crewOf(card: Issue, children: Issue[], input: CrewInput): CrewMember[] {
  const groups = new Map<string, { agent: Assignee; issues: Issue[] }>();
  for (const i of [card, ...[...children].sort((a, b) => a.createdAt.localeCompare(b.createdAt))]) {
    const agent = crewAgent(i, input.assignees);
    if (!agent) continue;
    const g = groups.get(agent.key) ?? { agent, issues: [] };
    g.issues.push(i);
    groups.set(agent.key, g);
  }
  const members = [...groups.values()].map(({ agent, issues }): CrewMember => {
    const states = issues.map((i) => ({ id: i.id, identifier: i.identifier, title: i.title, state: issueState(i, agent, input) }));
    const since = issues.map((i) => input.working.get(i.identifier)?.since).find((s) => s !== undefined);
    return {
      agent: agent.key,
      state: mostUrgent(states.map((s) => s.state)),
      issues: states,
      ...(states.length > 1 ? { finished: states.filter((s) => s.state === "done" || s.state === "needs").length } : {}),
      ...(since !== undefined ? { since } : {}),
    };
  });
  return members.sort((a, b) => Number(b.agent === assistantKey(input.assignees)) - Number(a.agent === assistantKey(input.assignees)));
}

const assistantKey = (list: Assignee[]) => list.find((a) => a.kind === "assistant")?.key;

/** One line of an agent's latest comment, for the crew rows on a task. */
export function summaryOf(body: string, max = 180): string {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, " … ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*(Summary|Answer)\s*$/gim, "")
    .replace(/[#>*_`~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * What the new agent is told when a stuck agent's part goes to them: the user's original
 * instructions, and that someone tried first. The earlier attempt's notes reach them as context
 * (never as instructions), so only the user's own words are passed on here.
 */
export function handOverText(instructions: string, from: string): string {
  return `${instructions.trim()}\n\n${from} worked on this first and got stuck; their notes are on the task.`;
}

/** States that wait on the user: the board's "Needs you". */
export const NEEDS_USER: ReadonlySet<CrewState> = new Set(["needs", "failed", "proposed"]);
