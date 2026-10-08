// Board logic: which tasks show where, who they're assigned to, and how edits map onto Paperclip.
// Pure functions (unit-tested); I/O is in app.ts.
import { z } from "zod";
import type { Agent, Comment, Issue, Label } from "./paperclip.js";
import { BUCKETS, type Bucket, type Placement } from "./store.js";

export const RUNNER_MARKER = "<!-- pennyworth-runner -->";
export const BRIEF_LABEL = "daily-brief";

export type Engine = "codex" | "claude" | "openrouter";
const ADAPTER_ENGINE: Record<string, Engine> = { codex_local: "codex", claude_local: "claude", opencode_local: "openrouter" };
const EFFORT_KEY: Partial<Record<Engine, string>> = { codex: "modelReasoningEffort", claude: "effort" };
export const EFFORTS: Record<Engine, string[]> = { codex: ["low", "medium", "high", "xhigh"], claude: ["low", "medium", "high", "xhigh", "max"], openrouter: [] };

/** Someone a task can be assigned to from the board: the user, the Assistant, or an Engineer (D-20). */
export interface Assignee {
  key: string; // "me" or the agent id
  kind: "me" | "assistant" | "engineer";
  name: string;
  engine?: Engine;
  adapterType?: string;
  defaultModel?: string;
  efforts?: string[];
}

export function assignees(agents: Agent[]): Assignee[] {
  const live = agents.filter((a) => a.status !== "terminated");
  const out: Assignee[] = [{ key: "me", kind: "me", name: "You" }];
  const assistant = live.find((a) => a.metadata?.setupKey === "pennyworth:assistant");
  if (assistant) out.push({ key: assistant.id, kind: "assistant", name: assistant.name });
  const engineers = live.filter((a) => /^pennyworth:engineer(-|$)/.test(a.metadata?.setupKey ?? "") && ADAPTER_ENGINE[a.adapterType]);
  const order: Engine[] = ["codex", "claude", "openrouter"];
  engineers.sort((a, b) => order.indexOf(ADAPTER_ENGINE[a.adapterType]!) - order.indexOf(ADAPTER_ENGINE[b.adapterType]!));
  for (const a of engineers) {
    const engine = ADAPTER_ENGINE[a.adapterType]!;
    const model = typeof a.adapterConfig?.model === "string" ? a.adapterConfig.model : "";
    out.push({ key: a.id, kind: "engineer", name: a.name, engine, adapterType: a.adapterType, defaultModel: model || undefined, efforts: EFFORTS[engine] });
  }
  return out;
}

export function assigneeKey(issue: Issue, list: Assignee[]): string | null {
  if (issue.assigneeAgentId) return list.some((a) => a.key === issue.assigneeAgentId) ? issue.assigneeAgentId : null;
  return issue.assigneeUserId ? "me" : null;
}

/** The task's model and effort override, when it's assigned to an Engineer. */
export function executorOf(issue: Issue, list: Assignee[]): { model?: string; effort?: string } | undefined {
  const a = list.find((x) => x.key === issue.assigneeAgentId && x.kind === "engineer");
  if (!a?.engine) return undefined;
  const config = issue.assigneeAdapterOverrides?.adapterConfig ?? {};
  const key = EFFORT_KEY[a.engine];
  const model = typeof config.model === "string" && config.model.trim() ? config.model.trim() : undefined;
  const effort = key && typeof config[key] === "string" && config[key] ? String(config[key]) : undefined;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export interface Card {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
  labels: { name: string; color: string }[];
  assignee: string | null;
  executor?: { model?: string; effort?: string };
  unread: boolean;
  createdAt: string;
  activityAt: string;
  /** A move scheduled for a later date (D-25). */
  scheduled?: { date: string; bucket: Bucket };
  /** Set on recurring tasks (D-25): the rule in words and the next run. */
  recurring?: { summary: string; nextRun: string | null; paused: boolean };
}

export function toCard(issue: Issue, list: Assignee[], seenAt: string): Card {
  const activityAt = issue.lastActivityAt ?? issue.updatedAt;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    labels: (issue.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    assignee: assigneeKey(issue, list),
    executor: executorOf(issue, list),
    unread: activityAt > seenAt,
    createdAt: issue.createdAt,
    activityAt,
  };
}

const isBrief = (i: Issue) => (i.labels ?? []).some((l) => l.name === BRIEF_LABEL);

export interface BoardInput {
  open: Issue[];
  closed: Issue[];
  placements: Map<string, Placement>;
  seen: Map<string, string>;
  schedules?: Map<string, { date: string; bucket: Bucket }>;
  recurring?: Map<string, NonNullable<Card["recurring"]>>;
  installedAt: string;
  assignees: Assignee[];
}

export interface Board {
  buckets: Record<Bucket, Card[]>;
  brief: { id: string; identifier: string; title: string; description: string } | null;
  done: Card[];
  /** Recurring tasks: outside the columns, by next run. */
  recurring: Card[];
}

/** Open tasks by bucket and rank, today's brief, recurring tasks, and recently closed tasks (newest first). */
export function buildBoard(input: BoardInput): Board {
  const seen = (id: string) => input.seen.get(id) ?? input.installedAt;
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, [] as Card[]])) as Record<Bucket, Card[]>;
  const ranked = new Map<string, number>();
  const unique = new Map(input.open.map((i) => [i.id, i]));
  const briefs = [...unique.values()].filter(isBrief).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recurring: Card[] = [];
  for (const issue of unique.values()) {
    if (isBrief(issue)) continue;
    const card = toCard(issue, input.assignees, seen(issue.id));
    const rule = input.recurring?.get(issue.id);
    if (rule) {
      recurring.push({ ...card, recurring: rule });
      continue;
    }
    const scheduled = input.schedules?.get(issue.id);
    if (scheduled) card.scheduled = { date: scheduled.date, bucket: scheduled.bucket };
    const p = input.placements.get(issue.id) ?? { bucket: "triage" as Bucket, rank: -Infinity };
    buckets[p.bucket].push(card);
    ranked.set(issue.id, p.rank);
  }
  recurring.sort((a, b) => (a.recurring!.nextRun ?? "~").localeCompare(b.recurring!.nextRun ?? "~"));
  for (const b of BUCKETS) buckets[b].sort((x, y) => ranked.get(x.id)! - ranked.get(y.id)! || y.createdAt.localeCompare(x.createdAt));
  const brief = briefs[0];
  const done = [...new Map(input.closed.filter((i) => !isBrief(i)).map((i) => [i.id, i])).values()]
    .sort((a, b) => closedAt(b).localeCompare(closedAt(a)))
    .map((i) => toCard(i, input.assignees, seen(i.id)));
  return {
    buckets,
    brief: brief ? { id: brief.id, identifier: brief.identifier, title: brief.title, description: displayText(brief.description) } : null,
    done,
    recurring,
  };
}

const closedAt = (i: Issue) => i.completedAt ?? i.cancelledAt ?? i.updatedAt;

/** Hidden markers (source, runner) never show; Markdown is rendered and sanitised in the browser. */
export function displayText(text: string | null | undefined): string {
  return String(text ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** Keep the source marker when the user edits a description: deduplication depends on it. */
export function keepMarkers(original: string | null | undefined, edited: string): string {
  const markers = String(original ?? "").match(/<!-- source:[^>]*-->/g) ?? [];
  const text = displayText(edited);
  return markers.length ? `${text}\n\n${markers.join("\n")}` : text;
}

export interface CommentView {
  id: string;
  body: string;
  author: { kind: "me" | "runner" | "agent" | "user"; name: string };
  createdAt: string;
}

export function commentView(c: Comment, me: string, agents: Agent[]): CommentView {
  const author: CommentView["author"] =
    c.authorType === "agent"
      ? { kind: "agent", name: agents.find((a) => a.id === c.authorAgentId)?.name ?? "Agent" }
      : c.body.includes(RUNNER_MARKER)
        ? { kind: "runner", name: "Runner" }
        : c.authorUserId && c.authorUserId !== me
          ? { kind: "user", name: "Someone else" }
          : { kind: "me", name: "You" };
  return { id: c.id, body: displayText(c.body), author, createdAt: c.createdAt };
}

/** Who reads a reply on this task (shown under the reply box). */
export function replyTarget(issue: Issue, list: Assignee[]): string {
  const labels = new Set((issue.labels ?? []).map((l) => l.name));
  const a = list.find((x) => x.key === issue.assigneeAgentId);
  if (a?.kind === "engineer" || labels.has("engineer")) return "The runner reads replies here and starts or continues the coding job.";
  if (labels.has("needs-review")) return "Pennyworth applies review replies here (pick N, ignore).";
  if (a?.kind === "assistant") return "The Assistant is working on this and reads replies.";
  return "The Assistant picks up replies here after about 90 seconds.";
}

// ------------------------------------------------------------------ edits

const id = z.string().regex(/^[0-9a-f-]{36}$/);
export const UpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(60_000),
    status: z.enum(["todo", "in_progress", "done", "cancelled"]),
    priority: z.enum(["critical", "high", "medium", "low"]),
    assignee: z.union([z.literal("me"), id]),
    model: z.string().trim().max(120).regex(/^[A-Za-z0-9._:/\[\]-]*$/),
    effort: z.string().max(10),
    labelIds: z.array(id).max(20),
  })
  .partial()
  .strict();
export type Update = z.infer<typeof UpdateSchema>;

/**
 * The Paperclip PATCH body for a board edit. Assignees are limited to the user, the Assistant and
 * the Engineers; model and effort only apply to Engineers; labels must exist.
 */
export function paperclipUpdate(issue: Issue, u: Update, ctx: { me: string; assignees: Assignee[]; labels: Label[] }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (u.title !== undefined) body.title = u.title;
  if (u.description !== undefined) body.description = keepMarkers(issue.description, u.description);
  if (u.status !== undefined) body.status = u.status;
  if (u.priority !== undefined) body.priority = u.priority;
  if (u.labelIds !== undefined) {
    const known = new Set(ctx.labels.map((l) => l.id));
    if (u.labelIds.some((l) => !known.has(l))) throw new BadRequest("unknown label");
    body.labelIds = u.labelIds;
  }
  let target = ctx.assignees.find((a) => a.key === (issue.assigneeAgentId ?? (issue.assigneeUserId ? "me" : "")));
  if (u.assignee !== undefined) {
    target = ctx.assignees.find((a) => a.key === u.assignee);
    if (!target) throw new BadRequest("unknown assignee");
    if (target.kind === "me") Object.assign(body, { assigneeUserId: ctx.me, assigneeAgentId: null, assigneeAdapterOverrides: null });
    else Object.assign(body, { assigneeAgentId: target.key, assigneeUserId: null, assigneeAdapterOverrides: null });
  }
  if (u.model !== undefined || u.effort !== undefined) {
    if (target?.kind !== "engineer" || !target.engine) throw new BadRequest("model and effort only apply to an Engineer");
    const current = u.assignee !== undefined ? {} : executorOf(issue, ctx.assignees) ?? {};
    let model = u.model !== undefined ? u.model : current.model ?? "";
    if (model && target.engine === "openrouter" && !model.startsWith("openrouter/")) model = `openrouter/${model}`;
    const effort = u.effort !== undefined ? u.effort : current.effort ?? "";
    if (effort && !target.efforts?.includes(effort)) throw new BadRequest(`effort must be one of ${target.efforts?.join(", ") || "(none)"}`);
    const config: Record<string, string> = {};
    if (model && model !== target.defaultModel) config.model = model;
    if (effort) config[EFFORT_KEY[target.engine]!] = effort;
    body.assigneeAdapterOverrides = Object.keys(config).length ? { adapterConfig: config } : null;
  }
  return body;
}

export const CreateSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(60_000).default(""),
    bucket: z.enum(BUCKETS).default("triage"),
  })
  .strict();

export class BadRequest extends Error {}
