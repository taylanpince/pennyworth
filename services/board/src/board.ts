// Board logic: which tasks show where, who they're assigned to, and how edits map onto Paperclip.
// Pure functions (unit-tested); I/O is in app.ts.
import { z } from "zod";
import { crewOf, foldedChildren, type CrewInput, type CrewMember } from "./crew.js";
import type { Agent, Comment, Issue, Label } from "./paperclip.js";
import { BUCKETS, type Bucket, type Placement } from "./store.js";

export const RUNNER_MARKER = "<!-- pennyworth-runner -->";
export const BRIEF_LABEL = "daily-brief";

export type Engine = "codex" | "claude" | "openrouter";
export const ENGINES: Engine[] = ["claude", "codex", "openrouter"];
export const ENGINE_ADAPTER: Record<Engine, string> = { codex: "codex_local", claude: "claude_local", openrouter: "opencode_local" };
const ADAPTER_ENGINE: Record<string, Engine> = { codex_local: "codex", claude_local: "claude", opencode_local: "openrouter" };
const EFFORT_KEY: Partial<Record<Engine, string>> = { codex: "modelReasoningEffort", claude: "effort" };
export const EFFORTS: Record<Engine, string[]> = { codex: ["low", "medium", "high", "xhigh"], claude: ["low", "medium", "high", "xhigh", "max"], openrouter: [] };

/**
 * Someone a task can be assigned to from the board: the user, the Assistant, another woken crew member
 * (the Writer), or one of the runner's roles (D-20, D-60). For the crew, the role is the character and
 * the engine a setting: `engine` and `defaultModel` are the role's own, `engines` what the picker offers.
 */
export interface Assignee {
  key: string; // "me" or the agent id
  kind: "me" | "assistant" | "agent" | "engineer";
  name: string;
  /** What the crew member takes on, in one line (D-60). */
  role?: string;
  engine?: Engine;
  engines?: Engine[];
  adapterType?: string;
  defaultModel?: string;
  defaultEffort?: string;
  /** Models offered per engine (setup's engine catalog), besides Paperclip's own list. */
  catalog?: Partial<Record<Engine, string[]>>;
  efforts?: string[];
  /** The crew member's name, voice and avatar (D-45), from config/paperclip.yaml via setup. */
  persona?: Persona;
}

/** One of the runner's crew roles: set up as one (D-60), or an Engineer from before roles. */
export function isRole(a: Agent): boolean {
  return (a.metadata as { runnerEngine?: unknown } | null | undefined)?.runnerEngine === true || /^pennyworth:engineer(-|$)/.test(a.metadata?.setupKey ?? "");
}

/** A role's own engine, model and effort (metadata `role`), else the adapter and primary model it had before roles. */
export function roleEngine(a: Agent): { engine: Engine; model?: string; effort?: string } | undefined {
  const role = (a.metadata as { role?: { engine?: unknown; model?: unknown; effort?: unknown } } | null | undefined)?.role;
  if (role && ENGINES.includes(role.engine as Engine)) {
    return { engine: role.engine as Engine, ...(typeof role.model === "string" && role.model ? { model: role.model } : {}), ...(typeof role.effort === "string" && role.effort ? { effort: role.effort } : {}) };
  }
  const engine = ADAPTER_ENGINE[a.adapterType];
  const model = typeof a.adapterConfig?.model === "string" ? a.adapterConfig.model : "";
  return engine ? { engine, ...(model ? { model } : {}) } : undefined;
}

const roleOf = (a: Agent): string | undefined => {
  const job = (a.metadata as { role?: { job?: unknown } } | null | undefined)?.role?.job;
  return typeof job === "string" && job.trim() ? job.trim().slice(0, 200) : undefined;
};

/** The models each engine offers in the picker: setup's catalog, and an OpenRouter Engineer's list from before it. */
function catalogOf(a: Agent): Partial<Record<Engine, string[]>> {
  const out: Partial<Record<Engine, string[]>> = {};
  const engines = (a.metadata as { engines?: Record<string, unknown> } | null | undefined)?.engines ?? {};
  for (const e of ENGINES) {
    const list = Array.isArray(engines[e]) ? (engines[e] as unknown[]).filter((m): m is string => typeof m === "string") : [];
    if (list.length) out[e] = list;
  }
  if (a.adapterType === "opencode_local" && !out.openrouter) {
    const legacy = [a.adapterConfig?.model, ...(Array.isArray(a.metadata?.models) ? a.metadata.models : [])].filter((m): m is string => typeof m === "string" && m.startsWith("openrouter/"));
    if (legacy.length) out.openrouter = [...new Set(legacy)];
  }
  return out;
}

// Roles in the order they're offered: the generalist first, then by how often each kind of work comes up.
const ROLE_ORDER = ["pennyworth:engineer-claude", "pennyworth:reviewer", "pennyworth:security", "pennyworth:sre"];

export interface Persona {
  name: string;
  voice: string;
  /** A portrait bundled with the board: /crew/<avatar>.svg. */
  avatar: string;
}

const PersonaSchema = z.object({ name: z.string().min(1).max(30), voice: z.string().max(200), avatar: z.string().regex(/^[a-z0-9-]{1,40}$/) });

export function personaOf(agent: Agent): Persona | undefined {
  const p = PersonaSchema.safeParse(agent.metadata?.persona);
  return p.success ? { name: p.data.name, voice: p.data.voice, avatar: p.data.avatar } : undefined;
}

export function assignees(agents: Agent[]): Assignee[] {
  const live = agents.filter((a) => a.status !== "terminated");
  const out: Assignee[] = [{ key: "me", kind: "me", name: "You" }];
  // Woken crew members (the Assistant, the Writer) run on Codex in Paperclip: the picker offers its models and effort.
  const woken = (a: Agent, kind: "assistant" | "agent"): Assignee => {
    const model = typeof a.adapterConfig?.model === "string" ? a.adapterConfig.model : "";
    const effort = typeof a.adapterConfig?.modelReasoningEffort === "string" ? a.adapterConfig.modelReasoningEffort : "";
    const role = roleOf(a);
    return { key: a.id, kind, name: a.name, ...(role ? { role } : {}), engine: "codex", engines: ["codex"], adapterType: a.adapterType, ...(model ? { defaultModel: model } : {}), ...(effort ? { defaultEffort: effort } : {}), efforts: EFFORTS.codex, ...withPersona(a) };
  };
  const assistant = live.find((a) => a.metadata?.setupKey === "pennyworth:assistant");
  if (assistant) out.push(woken(assistant, "assistant"));
  for (const a of live) if (a !== assistant && !isRole(a) && personaOf(a) && a.adapterType === "codex_local" && a.metadata?.setupKey?.startsWith("pennyworth:")) out.push(woken(a, "agent"));
  const roles = live.filter((a) => isRole(a) && roleEngine(a));
  const rank = (a: Agent) => (ROLE_ORDER.includes(a.metadata?.setupKey ?? "") ? ROLE_ORDER.indexOf(a.metadata!.setupKey!) : ROLE_ORDER.length);
  roles.sort((a, b) => rank(a) - rank(b));
  for (const a of roles) {
    const own = roleEngine(a)!;
    const role = roleOf(a);
    const catalog = catalogOf(a);
    out.push({
      key: a.id,
      kind: "engineer",
      name: a.name,
      ...(role ? { role } : {}),
      engine: own.engine,
      engines: ENGINES,
      adapterType: a.adapterType,
      ...(own.model ? { defaultModel: own.model } : {}),
      ...(own.effort ? { defaultEffort: own.effort } : {}),
      ...(Object.keys(catalog).length ? { catalog } : {}),
      efforts: EFFORTS[own.engine],
      ...withPersona(a),
    });
  }
  return out;
}

const withPersona = (a: Agent) => {
  const persona = personaOf(a);
  return persona ? { persona } : {};
};

export function assigneeKey(issue: Issue, list: Assignee[]): string | null {
  if (issue.assigneeAgentId) return list.some((a) => a.key === issue.assigneeAgentId) ? issue.assigneeAgentId : null;
  return issue.assigneeUserId ? "me" : null;
}

/** The task's executor override (D-60), when it's assigned to the crew: another engine than the role's, a model, an effort. */
export function executorOf(issue: Issue, list: Assignee[]): { engine?: Engine; model?: string; effort?: string } | undefined {
  const a = list.find((x) => x.key === issue.assigneeAgentId && x.kind !== "me");
  if (!a?.engine) return undefined;
  const config = issue.assigneeAdapterOverrides?.adapterConfig ?? {};
  const named = a.kind === "engineer" && ENGINES.includes(config.engine as Engine) && config.engine !== a.engine ? (config.engine as Engine) : undefined;
  const key = EFFORT_KEY[named ?? a.engine];
  const model = typeof config.model === "string" && config.model.trim() ? config.model.trim() : undefined;
  const effort = key && typeof config[key] === "string" && config[key] ? String(config[key]) : undefined;
  return { ...(named ? { engine: named } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
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
  /** In Today: how many workdays it has been carried over unfinished (D-28). */
  carried?: number;
  /** Set on recurring tasks (D-25): the rule in words and the next run. */
  recurring?: { summary: string; nextRun: string | null; paused: boolean };
  /** An agent is working on it now, or the runner has it queued. */
  working?: { agent: string; since: string | null; queued: boolean };
  /** The agents on the task (D-45): its own agent, and those working in its sub-tasks. */
  crew?: CrewMember[];
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
  /** Activity and runner results for the crew on each card (D-45); without it, cards have no crew. */
  crew?: Omit<CrewInput, "assignees" | "seen">;
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
  // Agents' sub-tasks fold into the card they work on (D-45).
  const all = [...new Map([...input.closed, ...input.open].map((i) => [i.id, i])).values()];
  const folded = foldedChildren(all, input.assignees);
  const children = new Map<string, Issue[]>();
  for (const i of all) if (folded.has(i.id)) children.set(folded.get(i.id)!, [...(children.get(folded.get(i.id)!) ?? []), i]);
  const crewInput = input.crew && { ...input.crew, assignees: input.assignees, seen };
  const withCrew = (card: Card, issue: Issue) => {
    const crew = crewInput ? crewOf(issue, children.get(issue.id) ?? [], crewInput) : [];
    if (crew.length) card.crew = crew;
    return card;
  };
  for (const issue of unique.values()) {
    if (isBrief(issue) || folded.has(issue.id)) continue;
    const card = withCrew(toCard(issue, input.assignees, seen(issue.id)), issue);
    const rule = input.recurring?.get(issue.id);
    if (rule) {
      recurring.push({ ...card, recurring: rule });
      continue;
    }
    const scheduled = input.schedules?.get(issue.id);
    if (scheduled) card.scheduled = { date: scheduled.date, bucket: scheduled.bucket };
    const p = input.placements.get(issue.id) ?? { bucket: "triage" as Bucket, rank: -Infinity, carried: 0 };
    if (p.bucket === "today" && p.carried > 0) card.carried = p.carried;
    buckets[p.bucket].push(card);
    ranked.set(issue.id, p.rank);
  }
  recurring.sort((a, b) => (a.recurring!.nextRun ?? "~").localeCompare(b.recurring!.nextRun ?? "~"));
  for (const b of BUCKETS) buckets[b].sort((x, y) => ranked.get(x.id)! - ranked.get(y.id)! || y.createdAt.localeCompare(x.createdAt));
  const brief = briefs[0];
  const done = [...new Map(input.closed.filter((i) => !isBrief(i) && !folded.has(i.id) && !unique.has(i.id)).map((i) => [i.id, i])).values()]
    .sort((a, b) => closedAt(b).localeCompare(closedAt(a)))
    .map((i) => withCrew(toCard(i, input.assignees, seen(i.id)), i));
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

/** Keep the source markers (merged tasks' too) when the user edits a description: deduplication depends on them. */
export function keepMarkers(original: string | null | undefined, edited: string): string {
  const markers = String(original ?? "").match(/<!-- (?:merged-)?source:[^>]*-->/g) ?? [];
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
  if (a?.kind === "assistant" || a?.kind === "agent") return `${a.persona?.name ?? a.name} is working on this and reads replies.`;
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
    engine: z.enum(["codex", "claude", "openrouter"]),
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
  if (u.engine !== undefined || u.model !== undefined || u.effort !== undefined) {
    if (!target || target.kind === "me" || !target.engine) throw new BadRequest("the engine, model and effort only apply to the crew");
    const current = u.assignee !== undefined ? {} : executorOf(issue, ctx.assignees) ?? {};
    const engine = u.engine ?? current.engine ?? target.engine;
    if (!(target.engines ?? [target.engine]).includes(engine)) throw new BadRequest(`${target.persona?.name ?? target.name} runs on ${(target.engines ?? [target.engine]).join(", ")}`);
    // A model belongs to its engine: switching engine without naming one runs that engine's default.
    const switched = engine !== (current.engine ?? target.engine);
    let model = u.model !== undefined ? u.model : switched ? "" : current.model ?? "";
    if (model && engine === "openrouter" && !model.startsWith("openrouter/")) model = `openrouter/${model}`;
    const effort = u.effort !== undefined ? u.effort : switched ? "" : current.effort ?? "";
    if (effort && !EFFORTS[engine].includes(effort)) throw new BadRequest(`effort must be one of ${EFFORTS[engine].join(", ") || "(none)"}`);
    // Only these keys ever go in the override: Paperclip merges it into a woken agent's run config.
    const config: Record<string, string> = {};
    if (engine !== target.engine) config.engine = engine;
    if (model && (engine !== target.engine || model !== target.defaultModel)) config.model = model;
    if (effort && (engine !== target.engine || effort !== target.defaultEffort)) config[EFFORT_KEY[engine]!] = effort;
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

/** Bring an agent onto one of your tasks with instructions (D-45). */
export const AddAgentSchema = z
  .object({
    agent: z.string().min(1).max(64),
    instructions: z.string().trim().min(1).max(30_000),
    engine: z.enum(["codex", "claude", "openrouter"]).optional(),
    model: z.string().trim().max(120).regex(/^[A-Za-z0-9._:/\[\]-]*$/).optional(),
    effort: z.string().trim().max(20).optional(),
  })
  .strict();

/** Give a stuck agent's part of a task to another agent (D-45). */
export const HandOverSchema = z.object({ from: z.string().min(1).max(64), to: z.string().min(1).max(64) }).strict();
/** An agent passing one of the user's comments on to another agent (D-54): which comment, to whom, and who passes it. */
export const PassSchema = z.object({ comment: id, to: z.string().min(1).max(64), by: z.string().max(64).optional() }).strict();

export class BadRequest extends Error {}
