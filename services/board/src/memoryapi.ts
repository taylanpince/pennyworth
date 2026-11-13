// Memory routes (D-61): the internal API the tasks bridge and the runner call for their agents, the
// board's own API for the Memory view, and recording finished tasks as episodes. The write gate is
// here, in code: an agent's "remember" becomes an active memory only when the comment it names is the
// user's own, recent, on that task (or its parent or parts) and asks to remember; anything else waits
// for the user as a proposal. Agents choose the comment, never whether the user said it.
import type { Logger } from "pino";
import { z } from "zod";
import { BadRequest, RUNNER_MARKER, displayText, personaOf } from "./board.js";
import { GLOBAL, KINDS, MemoryRefused, SCOPE, STATUSES, type Memory, type MemoryStore } from "./memory.js";
import type { Agent, Comment, Issue, Paperclip } from "./paperclip.js";

/** Words that ask an agent to keep something for later (checked on the user's comment, hidden markers stripped). */
export const REMEMBER_INTENT = /\b(remember|memori[sz]e|keep in mind|note (this|that)|from now on|going forward|next time|in (the )?future|always|never)\b/i;
/** How old the user's comment may be for a "remember" to count. */
const REMEMBER_WINDOW_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;
/** Per task and day: remembers, and proposals. Per scope: proposals waiting for the user. */
export const CAPS = { remember: 10, propose: 3, pending: 20 };

const REF = /^(?:[0-9a-f-]{36}|[A-Z][A-Z0-9]{1,9}-\d{1,7})$/;
const REPLY_MARKER = "<!-- pennyworth-reply -->";
const PR_LINK = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** A crew member's memory scope (D-45 personas): its setup key without `pennyworth:`. */
export interface CrewScope {
  scope: string;
  agentId: string;
  name: string;
  avatar: string;
}

/** The scopes agents can have: every agent with a persona. The others (scouts, the brief) read the global rules only. */
export function crewScopes(agents: Agent[]): CrewScope[] {
  const out: CrewScope[] = [];
  for (const a of agents) {
    const persona = personaOf(a);
    const key = /^pennyworth:([a-z0-9][a-z0-9-]{0,39})$/.exec(a.metadata?.setupKey ?? "")?.[1];
    if (a.status === "terminated" || !persona || !key || key === GLOBAL) continue;
    if (!out.some((s) => s.scope === key)) out.push({ scope: key, agentId: a.id, name: persona.name, avatar: persona.avatar });
  }
  return out;
}

/** Where a memory goes: "global", "self" (the caller's own), or another crew member by name or key. */
export function resolveTarget(target: string | undefined, own: string, scopes: CrewScope[]): string {
  const t = String(target ?? "").trim().toLowerCase();
  if (!t || t === "self" || t === "me" || t === "mine") return own;
  if (t === GLOBAL || t === "everyone" || t === "all") return GLOBAL;
  const s = scopes.find((x) => x.name.toLowerCase() === t || x.scope === t);
  if (!s) throw new MemoryRefused(`no agent is called ${target}: say global, self, or one of ${scopes.map((x) => x.name).join(", ")}`);
  return s.scope;
}

const Kind = z.enum(KINDS);
const Scope = z.string().regex(SCOPE);
const Ref = z.string().regex(REF);
const RecallSchema = z.object({ scope: Scope.nullish(), engine: z.string().max(40).optional() }).strict();
const SearchSchema = z.object({ scope: Scope.nullish(), query: z.string().trim().min(1).max(300), limit: z.number().int().min(1).max(50).optional(), engine: z.string().max(40).optional() }).strict();
const RememberSchema = z.object({ scope: Scope, target: z.string().max(40).optional(), kind: Kind, text: z.string().max(20_000), issue: Ref, comment: z.string().max(64) }).strict();
const ProposeSchema = z.object({ scope: Scope, target: z.string().max(40).optional(), kind: Kind, text: z.string().max(20_000), why: z.string().trim().min(1, "say why it will matter in future tasks").max(2000), issue: Ref, comment: z.string().max(64).optional() }).strict();
const CreateSchema = z.object({ scope: Scope, kind: Kind, text: z.string().max(20_000), pinned: z.boolean().optional(), sensitive: z.boolean().optional() }).strict();
const PatchSchema = z.object({ text: z.string().max(20_000).optional(), kind: Kind.optional(), scope: Scope.optional(), pinned: z.boolean().optional(), sensitive: z.boolean().optional(), status: z.enum(STATUSES).optional() }).strict();
const AcceptSchema = z.object({ text: z.string().max(20_000).optional(), kind: Kind.optional(), scope: Scope.optional() }).strict();

type Route = { method: string; path: RegExp; maxBody?: number; handle: (m: RegExpMatchArray, body: unknown, url: URL) => Promise<unknown> };

export interface MemoryDeps {
  paperclip: Paperclip;
  memory: MemoryStore;
  log: Logger;
  /** An HTTP error with a status (app.ts's own), for refusals that aren't plain bad requests. */
  fail: (status: number, message: string) => Error;
}

/** The comment an agent named, checked as the user's own words asking to remember something; or why not. */
export async function rememberGate(pc: Paperclip, issue: Issue, commentId: string, now = Date.now()): Promise<{ ok: true; comment: Comment } | { ok: false; reason: string }> {
  const me = await pc.me();
  const comment = await findComment(pc, issue, commentId, me);
  if (!comment) return { ok: false, reason: "the comment it names isn't on this task or its parts" };
  if (comment.authorType !== "user" || comment.authorUserId !== me || comment.authorAgentId || comment.body.includes(RUNNER_MARKER)) return { ok: false, reason: "the comment it names isn't the user's own" };
  if (now - Date.parse(comment.createdAt) > REMEMBER_WINDOW_MS) return { ok: false, reason: "the user's comment is more than 7 days old" };
  if (!REMEMBER_INTENT.test(displayText(comment.body))) return { ok: false, reason: "the user's comment doesn't ask to remember anything" };
  return { ok: true, comment };
}

/** A comment on the task, or on the user's task it belongs to and that task's other parts (D-45). */
async function findComment(pc: Paperclip, issue: Issue, id: string, me: string): Promise<Comment | undefined> {
  const live = (list: Comment[]) => list.find((c) => c.id === id && !c.deletedAt);
  const own = live(await pc.comments(issue.id));
  if (own) return own;
  const task = issue.assigneeUserId === me && !issue.assigneeAgentId ? issue : issue.parentId ? await pc.issue(issue.parentId).catch(() => undefined) : undefined;
  if (!task || task.assigneeUserId !== me) return undefined;
  for (const other of [task, ...(await pc.children(task.id))].filter((i) => i.id !== issue.id)) {
    const c = live(await pc.comments(other.id));
    if (c) return c;
  }
  return undefined;
}

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequest(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

/** A refusal from the store is a bad request with its reason. */
async function refusing<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MemoryRefused) throw new BadRequest(err.message);
    throw err;
  }
}

/** A memory as the agents see it in search results. */
const forAgent = (m: Memory) => ({ id: m.id, scope: m.scope, kind: m.kind, text: m.text, pinned: m.pinned });

export function memoryRoutes({ paperclip: pc, memory, log, fail }: MemoryDeps) {
  const scopes = async () => crewScopes(await pc.agents());

  async function caller(scope: string) {
    const list = await scopes();
    const own = list.find((s) => s.scope === scope);
    if (!own) throw fail(403, "only crew agents (with a persona) keep memories");
    return { own, list };
  }

  async function sourceIssue(ref: string) {
    return pc.issue(ref);
  }

  const since = () => new Date(Date.now() - DAY_MS).toISOString();
  const pendingCap = (scope: string) => {
    if (memory.pending(scope) >= CAPS.pending) throw fail(429, `${CAPS.pending} proposals for ${scope} are already waiting for the user's review on the board: don't propose more until they've gone through them`);
  };

  // The tasks bridge and the runner, for their agents (bearer token, mode "internal").
  const internal: Route[] = [
    {
      method: "POST",
      path: /^\/internal\/memory\/recall$/,
      handle: async (_m, body) => {
        const { scope, engine } = parse(RecallSchema, body);
        // A scope that isn't a crew member's (scouts, the brief) gets the global rules only.
        const own = scope && (await scopes()).some((s) => s.scope === scope) ? scope : null;
        return memory.recall(own, { engine });
      },
    },
    {
      method: "POST",
      path: /^\/internal\/memory\/search$/,
      handle: async (_m, body) => {
        const { scope, query, limit, engine } = parse(SearchSchema, body);
        const own = scope && (await scopes()).some((s) => s.scope === scope) ? scope : null;
        const found = memory.search(own, query, { limit, engine });
        return { memories: found.memories.map(forAgent), episodes: found.episodes };
      },
    },
    {
      // The user said to remember something. Active only through the gate; otherwise it waits as a proposal.
      method: "POST",
      path: /^\/internal\/memory\/remember$/,
      handle: async (_m, body) => {
        const input = parse(RememberSchema, body);
        const { own, list } = await caller(input.scope);
        const target = await refusing(() => resolveTarget(input.target, own.scope, list));
        const issue = await sourceIssue(input.issue);
        if (memory.countFrom(issue.identifier, "remember", since()) >= CAPS.remember) throw fail(429, `at most ${CAPS.remember} memories a day from one task`);
        const gate = await rememberGate(pc, issue, input.comment);
        if (!gate.ok) pendingCap(target);
        const { memory: m, duplicate } = await refusing(() =>
          memory.add({
            scope: target,
            kind: input.kind,
            text: input.text,
            status: gate.ok ? "active" : "proposed",
            origin: "remember",
            createdBy: own.name,
            why: gate.ok ? null : `Asked to remember, but ${gate.reason}.`,
            sourceIssue: issue.identifier,
            sourceComment: input.comment,
          }),
        );
        log.info({ memory: m.id, scope: target, kind: m.kind, status: m.status, by: own.name, issue: issue.identifier, duplicate }, "memory remembered");
        const where = target === GLOBAL ? "every agent" : target === own.scope ? "you" : list.find((s) => s.scope === target)?.name ?? target;
        return {
          id: m.id,
          scope: target,
          status: m.status,
          duplicate,
          message:
            m.status === "active"
              ? `${duplicate ? "Already remembered" : "Remembered"} for ${where} as #${m.id}.`
              : `Not remembered yet: ${gate.ok ? "it was proposed earlier" : gate.reason}. Saved as proposal #${m.id} for the user to accept on the board's Memory view; say so.`,
        };
      },
    },
    {
      // An agent suggests a memory from the user's corrections: it waits for the user on the board.
      method: "POST",
      path: /^\/internal\/memory\/propose$/,
      handle: async (_m, body) => {
        const input = parse(ProposeSchema, body);
        const { own, list } = await caller(input.scope);
        const target = await refusing(() => resolveTarget(input.target, own.scope, list));
        const issue = await sourceIssue(input.issue);
        if (memory.countFrom(issue.identifier, "proposal", since()) >= CAPS.propose) throw fail(429, `at most ${CAPS.propose} proposals a day from one task: keep the ones that matter most`);
        pendingCap(target);
        const { memory: m, duplicate } = await refusing(() =>
          memory.add({ scope: target, kind: input.kind, text: input.text, status: "proposed", origin: "proposal", createdBy: own.name, why: input.why, sourceIssue: issue.identifier, sourceComment: input.comment ?? null }),
        );
        log.info({ memory: m.id, scope: target, kind: m.kind, by: own.name, issue: issue.identifier, duplicate }, "memory proposed");
        return {
          id: m.id,
          scope: target,
          status: m.status,
          duplicate,
          message: m.status === "active" ? `That's already remembered as #${m.id}.` : m.status === "rejected" ? `The user turned this down before (#${m.id}): don't propose it again.` : `Proposed as #${m.id}: the user reviews it on the board's Memory view.`,
        };
      },
    },
  ];

  /** Every scope the board shows: everyone, each crew member, and any scope that only has memories left. */
  async function scopeViews() {
    const crew = await scopes().catch(() => [] as CrewScope[]);
    const extra = [...new Set(memory.list().map((m) => m.scope))].filter((s) => s !== GLOBAL && !crew.some((c) => c.scope === s));
    return [
      { scope: GLOBAL, name: "Everyone", avatar: null as string | null, agentId: null as string | null },
      ...crew.map((c) => ({ scope: c.scope, name: c.name, avatar: c.avatar as string | null, agentId: c.agentId as string | null })),
      ...extra.map((s) => ({ scope: s, name: s, avatar: null, agentId: null })),
    ];
  }

  const known = async (scope: string) => {
    if (!(await scopeViews()).some((s) => s.scope === scope)) throw new BadRequest(`unknown scope ${scope}`);
  };
  const idOf = (m: RegExpMatchArray) => Number(m[1]);

  // The board's Memory view (local and LAN listeners, the user's own).
  const api: Route[] = [
    {
      method: "GET",
      path: /^\/api\/memory$/,
      handle: async (_m, _b, url) => {
        const q = url.searchParams;
        const status = q.get("status");
        const kind = q.get("kind");
        const views = await scopeViews();
        return {
          memories: memory.list({
            scope: q.get("scope") || undefined,
            status: status && (STATUSES as readonly string[]).includes(status) ? (status as Memory["status"]) : undefined,
            kind: kind && (KINDS as readonly string[]).includes(kind) ? (kind as Memory["kind"]) : undefined,
            q: q.get("q") ?? undefined,
          }),
          scopes: views,
          budgets: memory.budgets(views.map((s) => s.scope)),
          pending: memory.pending(),
        };
      },
    },
    { method: "GET", path: /^\/api\/memory\/pending$/, handle: async () => ({ pending: memory.pending() }) },
    {
      method: "GET",
      path: /^\/api\/memory\/episodes$/,
      handle: async (_m, _b, url) => ({ episodes: memory.episodes(url.searchParams.get("q") ?? "", Math.min(Number(url.searchParams.get("limit")) || 50, 200)) }),
    },
    {
      method: "POST",
      path: /^\/api\/memory$/,
      handle: async (_m, body) => {
        const input = parse(CreateSchema, body);
        await known(input.scope);
        const { memory: m } = await refusing(() => memory.add({ ...input, status: "active", origin: "board", createdBy: "you" }));
        log.info({ memory: m.id, scope: m.scope, kind: m.kind }, "memory added on the board");
        return m;
      },
    },
    {
      method: "PATCH",
      path: /^\/api\/memory\/(\d{1,9})$/,
      handle: async (m, body) => {
        const patch = parse(PatchSchema, body);
        if (patch.scope) await known(patch.scope);
        const out = await refusing(() => memory.update(idOf(m), patch));
        log.info({ memory: out.id, fields: Object.keys(patch) }, "memory changed");
        return out;
      },
    },
    {
      method: "POST",
      path: /^\/api\/memory\/(\d{1,9})\/accept$/,
      handle: async (m, body) => {
        const patch = parse(AcceptSchema, body);
        if (patch.scope) await known(patch.scope);
        const out = await refusing(() => memory.update(idOf(m), { ...patch, status: "active" }));
        log.info({ memory: out.id, scope: out.scope }, "memory accepted");
        return out;
      },
    },
    {
      method: "POST",
      path: /^\/api\/memory\/(\d{1,9})\/reject$/,
      handle: async (m) => {
        const out = await refusing(() => memory.update(idOf(m), { status: "rejected" }));
        log.info({ memory: out.id }, "memory rejected");
        return out;
      },
    },
    {
      method: "DELETE",
      path: /^\/api\/memory\/(\d{1,9})$/,
      handle: async (m) => {
        if (!memory.remove(idOf(m))) throw fail(404, "no such memory");
        log.info({ memory: idOf(m) }, "memory deleted");
        return { ok: true };
      },
    },
  ];

  // Finished tasks become episodes as the board sees them close (it loads the last 48 hours of closed ones).
  let recording: Promise<unknown> | undefined;
  function episodes(closed: Issue[]) {
    if (recording) return;
    recording = pc
      .agents()
      .then((agents) => recordEpisodes(pc, memory, closed, agents))
      .then((n) => n && log.info({ recorded: n }, "past tasks recorded"))
      .catch((err) => log.warn({ err: String((err as Error).message ?? err).slice(0, 300) }, "couldn't record past tasks"))
      .finally(() => (recording = undefined));
  }

  return { internal, api, episodes };
}

/**
 * Record each crew part, or task an Engineer ran, that closed as done (D-45): its title, the agent's
 * scope, when it closed, the PRs its comments link, and the agent's last reply as the summary. Once per
 * task. Returns how many were new.
 */
export async function recordEpisodes(pc: Paperclip, memory: MemoryStore, closed: Issue[], agents: Agent[]): Promise<number> {
  const crew = crewScopes(agents);
  let added = 0;
  for (const i of closed) {
    const scope = i.status === "done" && i.assigneeAgentId ? crew.find((s) => s.agentId === i.assigneeAgentId)?.scope : undefined;
    if (!scope || memory.hasEpisode(i.id)) continue;
    const comments = await pc.comments(i.id);
    // The agent's own comment, or the Engineer's reply the runner posted for it.
    const reply = [...comments].reverse().find((c) => (c.authorType === "agent" && c.authorAgentId === i.assigneeAgentId) || c.body.includes(REPLY_MARKER));
    const links = [...`${i.description ?? ""}\n${comments.map((c) => c.body).join("\n")}`.matchAll(PR_LINK)].map((m) => m[0]);
    if (memory.addEpisode({ issueId: i.id, identifier: i.identifier, title: i.title, scope, summary: reply ? displayText(reply.body).replace(/^Workspace: `.*$/m, "") : "", links, closedAt: i.completedAt ?? i.updatedAt })) added++;
  }
  return added;
}

/** The last `days` of finished crew work as episodes, once (for installs from before D-61). */
export async function backfillEpisodes(pc: Paperclip, memory: MemoryStore, days = 60): Promise<number> {
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const [closed, agents] = await Promise.all([pc.closedSince(since, "2000"), pc.agents()]);
  return recordEpisodes(pc, memory, closed, agents);
}
