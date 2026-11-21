import { SlackConnectionError, type SlackAuth } from "./slack.js";
import type { WhatsAppAuth } from "./whatsapp.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { RunnerReportSchema, agentsView, runTasks, workingOn, type RunContext, type RunnerReport } from "./activity.js";
import { RecurringSchema, RunStateSchema, ScheduleSchema, changeRecurring, claimDue, recurringView, scheduleMove } from "./automation.js";
import { AddAgentSchema, AssignSubtasksSchema, BadRequest, CreateSchema, MAX_SUBTASKS, ParentSchema, SubtaskSchema, EFFORTS, ENGINE_ADAPTER, type Engine, HandOverSchema, PassSchema, RUNNER_MARKER, UpdateSchema, assignees, buildBoard, commentView, displayText, executorOf, paperclipUpdate, replyTarget, toCard, type Assignee } from "./board.js";
import { FOR_OTHERS, crewOf, deliveredFrom, deliveredText, foldedChildren, fromMarker, handOverText, isSubtask, mentionedAgents, partsToClose, subtaskCount, summaryOf, type DeliveredFrom } from "./crew.js";
import { inNetworks } from "./config.js";
import { INLINE_TYPES, MAX_UPLOAD_BODY, UploadSchema, decode, fileType, fileViews, isPdf, pdfText, safeName } from "./files.js";
import { MergeSchema, mergedDescription } from "./merge.js";
import { memoryRoutes } from "./memoryapi.js";
import { statsRoutes } from "./statsapi.js";
import { McpAuthFailed, type ClickHouseAuth, type CloudflareAuth, type GleanAuth, type GrafanaAuth, type JiraAuth, type PrimerAuth } from "./mcpauth.js";
import { GoogleAuthFailed, loopbackPort, type GoogleAuth } from "./google.js";
import { Paperclip, PaperclipError, type Issue } from "./paperclip.js";
import { TelegramAuthFailed, type TelegramAuth } from "./telegram.js";
import { addDays, nextWorkday, type Weekday } from "./recurrence.js";
import { readBackup } from "./backup.js";
import { connectionsView, HostReportSchema, type HostReport } from "./connections.js";
import { RunnerPollSchema, SIGNIN_PROVIDERS, SignIns, type SignInProvider } from "./signins.js";
import { BUCKETS, isBucket, localDate, type Bucket, type Store } from "./store.js";
import { AUTOMATION_OFF, AutomationSchema, saveAutomation, storedAutomation, type Automation } from "./autosettings.js";
import { SUPERVISOR_MARKER, SupervisorAssignSchema, recordSupervisorAssignment, supervisorAssignments, supervisorInstructions, supervisorRefusal, supervisorView } from "./supervisor.js";

export interface AppOptions {
  paperclip: Paperclip;
  store: Store;
  log: Logger;
  allowedHosts: string[];
  staticDir: string;
  timezone: string;
  /** The days Tomorrow rolls into Today (D-28); Monday to Friday when not given. */
  workdays?: Weekday[];
  /** Slack host → workspace or organization ID, so the web app opens Slack links in the desktop app. */
  slackTeams?: Record<string, string>;
  /**
   * "local": the loopback listener, trusted as the user. "lan": the home-network listener (D-23):
   * only clients from `lan.clients`, and the API only for paired devices (session cookie).
   * "internal": the tasks bridge and the runner (D-25), with a bearer token, /internal/ routes only.
   */
  mode?: "local" | "lan" | "internal";
  lan?: { clients: string[]; url: string };
  internalToken?: string;
  /** Shared by the listeners: the runner reports to the internal one, the board reads it on the others. */
  activity?: { runner?: RunnerReport; host?: HostReport; checkHost?: boolean; signins?: SignIns; automationDefault?: Automation };
  /** Google sign-in state and re-consent (D-36); no banner and no reconnect without it. */
  google?: GoogleAuth;
  /** Telegram sign-in state and sign-in (D-37); no banner and no sign-in without it. */
  telegram?: TelegramAuth;
  whatsapp?: WhatsAppAuth;
  slackAuth?: SlackAuth;
  /** Glean sign-in state and sign-in (D-38); no banner and no sign-in without it. */
  glean?: GleanAuth;
  /** Grafana sign-in state and sign-in; no banner and no sign-in without it. */
  grafana?: GrafanaAuth;
  /** ClickHouse sign-in state and sign-in (D-57); no banner and no sign-in without it. */
  clickhouse?: ClickHouseAuth;
  /** Cloudflare sign-in state and sign-in (D-64); no banner and no sign-in without it. */
  cloudflare?: CloudflareAuth;
  /** Jira and Confluence sign-ins, one per Atlassian account (D-69); no banner and no sign-in without it. */
  jira?: JiraAuth;
  /** Primer sign-in state and sign-in (D-66). */
  primer?: PrimerAuth;
  /** The off-machine backup's status file (D-58); no banner without it. */
  backupStatus?: string;
}

const SESSION_COOKIE = "pw_session";
const sessionToken = (req: IncomingMessage) =>
  String(req.headers.cookie ?? "")
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === SESSION_COOKIE)?.[1];

const REF = /^(?:[0-9a-f-]{36}|[A-Z][A-Z0-9]{1,9}-\d{1,7})$/;
const RECENT_MS = 48 * 3_600_000;
const WORKWEEK: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday"];

// The page and its assets only. Remote images are blocked too (tracking pixels in email/Slack text).
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Requests must name an allowed host (DNS rebinding), and writes must be same-origin JSON with the
 * board's header (a cross-site form or fetch can't add it without a CORS preflight, which is never answered).
 */
export function checkRequest(req: Pick<IncomingMessage, "method" | "headers" | "url">, allowedHosts: string[]): string | undefined {
  const host = String(req.headers.host ?? "").toLowerCase();
  if (!allowedHosts.includes(host)) return "unknown host";
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return "JSON only";
  if (req.headers["x-pennyworth-board"] !== "1") return "missing board header";
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    try {
      if (new URL(origin).host.toLowerCase() !== host) return "cross-origin";
    } catch {
      return "bad origin";
    }
  } else if (origin === "null") return "opaque origin";
  if (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"]))) return "cross-site";
  return undefined;
}

export function createApp(opts: AppOptions): Server {
  const { paperclip: pc, store, log } = opts;

  async function context() {
    const [me, agents, labels, company] = await Promise.all([pc.me(), pc.agents(), pc.labels(), pc.company()]);
    return { me, agents, labels, assignees: assignees(agents), prefix: company.issuePrefix ?? "" };
  }

  /** The tasks the board shows: assigned to the user, the Assistant or an Engineer. */
  const mine = (issues: Issue[], ctx: { me: string; assignees: Assignee[] }) =>
    issues.filter((i) => (i.assigneeAgentId ? ctx.assignees.some((a) => a.key === i.assigneeAgentId) : i.assigneeUserId === ctx.me));

  /** A task the board may change: assigned to the user, the Assistant or an Engineer. */
  async function ownIssue(ref: string) {
    if (!REF.test(ref)) throw new HttpError(400, "bad task reference");
    const ctx = await context();
    const issue = await pc.issue(ref);
    const assigned = issue.assigneeAgentId ? ctx.assignees.some((a) => a.key === issue.assigneeAgentId) : issue.assigneeUserId === ctx.me;
    return { ctx, issue, assigned };
  }

  // Agent activity (Paperclip runs and the runner's jobs). The runner reports through the internal API.
  const shared = opts.activity ?? {};
  // One relay for the board's three listeners (they share `activity`).
  const signins = (shared.signins ??= new SignIns(() => randomBytes(12).toString("hex")));

  /** The task a run is attached to, and the user's tasks it works on. */
  async function runContext(issueId: string | null, prefix: string): Promise<RunContext> {
    if (!issueId) return { run: null, tasks: [] };
    const issue = await pc.issueSummary(issueId).catch(() => undefined);
    if (!issue) return { run: null, tasks: [] };
    const tasks = runTasks(issue, prefix);
    for (const t of tasks) t.title ??= (await refCache(t.identifier).catch(() => null))?.title;
    return { run: { identifier: issue.identifier, title: issue.title }, tasks, assigneeAgentId: issue.assigneeAgentId };
  }

  async function activity(ctx: { agents: Awaited<ReturnType<typeof pc.agents>>; prefix: string }, withPast: boolean) {
    const [live, past] = await Promise.all([pc.liveRuns(), withPast ? pc.recentRuns(30) : Promise.resolve([])]);
    const view = await agentsView({ live, past, runner: shared.runner, agents: ctx.agents, resolve: (id) => runContext(id, ctx.prefix) });
    // Runner jobs report only their identifier; the Crew view names the task.
    if (withPast) for (const t of [...view.sessions, ...view.finished].flatMap((x) => x.tasks)) t.title ??= (await refCache(t.identifier).catch(() => null))?.title;
    return view;
  }

  /** Who is working on which task. Never fails the board: without it, cards just show no activity. */
  async function working(ctx: Parameters<typeof activity>[0]) {
    try {
      const view = await activity(ctx, false);
      return { map: workingOn(view.sessions), active: view.sessions.filter((x) => x.state === "working").length };
    } catch (err) {
      log.warn({ err: String((err as Error).message ?? err).slice(0, 300) }, "agent activity unavailable");
      return { map: new Map<string, never>(), active: 0 };
    }
  }

  /** Close the crew parts of tasks closed elsewhere (`partsToClose`), and return the open tasks left. */
  async function closeLeftoverParts(open: Issue[], closed: Issue[], ctx: Awaited<ReturnType<typeof context>>): Promise<Issue[]> {
    const known = new Map([...open, ...closed].map((i) => [i.id, i]));
    const crew = (i: Issue) => ctx.assignees.some((a) => a.kind !== "me" && a.key === i.assigneeAgentId);
    // A parent closed before the recent window isn't loaded: fetch it.
    const missing = [...new Set(open.filter((i) => i.parentId && crew(i) && !known.has(i.parentId)).map((i) => i.parentId!))];
    for (const p of await Promise.all(missing.map((id) => pc.issue(id).catch(() => null)))) if (p) known.set(p.id, p);
    const ownCommentAt = async (part: Issue) => (await pc.comments(part.id)).filter((c) => commentView(c, ctx.me, []).author.kind === "me").at(-1)?.createdAt;
    const leftover = await partsToClose(open, known, ctx.assignees, ownCommentAt);
    if (!leftover.length) return open;
    const busy = (await working(ctx)).map;
    const gone = new Set<string>();
    for (const { part, status } of leftover) {
      if (busy.has(part.identifier)) continue;
      try {
        await pc.updateIssue(part.id, { status });
        gone.add(part.id);
        log.info({ issue: part.identifier, status }, "crew part closed with its task");
      } catch (err) {
        log.warn({ issue: part.identifier, err: String((err as Error).message ?? err).slice(0, 300) }, "could not close a crew part");
      }
    }
    return open.filter((i) => !gone.has(i.id));
  }

  /**
   * Put an agent on a task: a sub-task assigned to it, created as the user so the runner takes the
   * description as the user's request (D-45). An agent already on the task gets the instructions as a
   * comment on its part instead: one part per agent.
   */
  async function addToCrew(ctx: Awaited<ReturnType<typeof context>>, parent: Issue, agent: Assignee, instructions: string, executor: { engine?: Engine; model?: string; effort?: string }, marker = "") {
    // The user's words lose any hidden markers; only the board's own (where a message came from, D-54) stay.
    const text = marker ? `${displayText(instructions)}\n\n${marker}` : displayText(instructions);
    const existing = (await pc.children(parent.id)).find((k) => k.assigneeAgentId === agent.key && !["done", "cancelled"].includes(k.status));
    if (existing) {
      await pc.addComment(existing.id, text);
      log.info({ issue: parent.identifier, part: existing.identifier, agent: agent.name }, "instructions to the crew");
      return existing;
    }
    const assign = paperclipUpdate(
      { ...parent, assigneeAgentId: null, assigneeAdapterOverrides: null },
      { assignee: agent.key, ...(executor.engine ? { engine: executor.engine } : {}), ...(executor.model ? { model: executor.model } : {}), ...(executor.effort ? { effort: executor.effort } : {}) },
      ctx,
    );
    // Every part carries the task's title, which Paperclip would take for a duplicate of the first one.
    const part = await pc.createIssue({
      title: parent.title,
      description: text,
      status: "todo",
      priority: parent.priority,
      parentId: parent.id,
      allowDuplicate: true,
      ...assign,
    });
    if ((part as Issue & { deduplicated?: boolean }).deduplicated) throw new HttpError(409, `Paperclip returned ${part.identifier} instead of a new task`);
    store.markSeen(part.id, new Date(Date.now() + 5_000).toISOString());
    log.info({ issue: parent.identifier, part: part.identifier, agent: agent.name }, "agent joined");
    return part;
  }

  /** The user's task a chat belongs to: the task itself, or the task an agent's part is part of (D-45). */
  async function userTaskOf(issue: Issue, ctx: Awaited<ReturnType<typeof context>>): Promise<Issue | undefined> {
    if (issue.assigneeUserId === ctx.me && !issue.assigneeAgentId) return issue;
    if (!issue.parentId) return undefined;
    const parent = await pc.issue(issue.parentId);
    return parent.assigneeUserId === ctx.me ? parent : undefined;
  }

  const usersOwn = (i: Issue, ctx: { me: string }) => i.assigneeUserId === ctx.me && !i.assigneeAgentId;

  /** The board as the user sees it: every column's cards with their crew, from Paperclip and the board's SQLite. */
  async function boardSnapshot() {
    const ctx = await context();
    const since = new Date(Date.now() - RECENT_MS).toISOString();
    const [all, closed] = await Promise.all([pc.openIssues().then((l) => mine(l, ctx)), pc.closedSince(since).then((l) => mine(l, ctx))]);
    const open = await closeLeftoverParts(all, closed, ctx);
    mem.episodes(closed);
    // Agents' sub-tasks are part of their parent's card (D-45): they never get a place of their own.
    const folded = foldedChildren([...open, ...closed], ctx.assignees);
    store.placeNew(open.filter((i) => !folded.has(i.id)).map((i) => ({ id: i.id, createdAt: i.createdAt, status: i.status })));
    const recurring = new Map([...store.allRecurring()].map(([id, r]) => [id, { summary: recurringView(r, opts.timezone).summary, nextRun: r.nextRun, paused: r.paused }]));
    const busy = await working(ctx);
    const byId = new Map([...open, ...closed].map((i) => [i.id, i]));
    const withSubtasks = [...new Set([...open, ...closed].filter((i) => folded.has(i.id) && usersOwn(i, ctx)).map((i) => folded.get(i.id)!))].flatMap((id) => byId.get(id) ?? []);
    const subtasks = await subtaskCounts(withSubtasks);
    const board = buildBoard({ subtasks, open, closed, placements: store.placements(), seen: store.allSeen(), schedules: store.schedules(), recurring, installedAt: store.meta("installed_at")!, assignees: ctx.assignees, crew: { working: busy.map, jobs: latestJobs(shared.runner) } });
    for (const card of [...Object.values(board.buckets).flat(), ...board.recurring]) {
      const w = busy.map.get(card.identifier);
      if (w) card.working = w;
    }
    return { ctx, open, closed, board, busy };
  }
  const closedIssue = (i: Issue) => i.status === "done" || i.status === "cancelled";

  /** A task that can take subtasks (D-68): the user's own, open, not repeating, and not a subtask itself. */
  async function subtaskParent(ctx: Awaited<ReturnType<typeof context>>, task: Issue) {
    if (!usersOwn(task, ctx)) throw new HttpError(403, "subtasks go under your own tasks");
    if (task.parentId) throw new HttpError(400, `${task.identifier} is a subtask itself: subtasks go one level deep`);
    if (closedIssue(task)) throw new HttpError(409, `${task.identifier} is closed: reopen it first`);
    if (store.recurring(task.id)) throw new HttpError(409, `${task.identifier} repeats: its runs can't have subtasks`);
    const kids = await pc.children(task.id);
    if (kids.filter((k) => isSubtask(k, task)).length >= MAX_SUBTASKS) throw new HttpError(409, `a task takes at most ${MAX_SUBTASKS} subtasks`);
    return kids;
  }

  // Subtask counts per task (D-68), read from Paperclip: closed subtasks drop out of the board's lists after 48 hours.
  const counts = new Map<string, { at: number; value: { open: number; total: number } | undefined }>();
  async function subtaskCounts(tasks: Issue[]) {
    const out = new Map<string, { open: number; total: number }>();
    for (const t of tasks) {
      let hit = counts.get(t.id);
      if (!hit || Date.now() - hit.at > 30_000) {
        const kids = await pc.children(t.id).catch(() => undefined);
        if (!kids) continue;
        hit = { at: Date.now(), value: subtaskCount(t, kids) };
        counts.set(t.id, hit);
      }
      if (hit.value) out.set(t.id, hit.value);
    }
    return out;
  }

  /**
   * A message of the user's for one agent on their task (D-54), from a mention or passed on by another
   * agent: it goes to that agent's part as the user's own comment, with where it came from. Its latest part
   * takes it (reopened when it was done, so the work and the session carry on); otherwise it joins the task.
   */
  async function deliver(ctx: Awaited<ReturnType<typeof context>>, task: Issue, agent: Assignee, text: string, from: DeliveredFrom) {
    const body = deliveredText(displayText(text), from);
    const parts = (await pc.children(task.id)).filter((k) => k.assigneeAgentId === agent.key && k.status !== "cancelled");
    const part = parts.find((k) => k.status !== "done") ?? parts.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
    if (!part) return addToCrew(ctx, task, agent, body, {}, fromMarker(from));
    if (part.status === "done") await pc.updateIssue(part.id, { status: "todo" });
    await pc.addComment(part.id, `${body}\n\n${fromMarker(from)}`);
    log.info({ issue: task.identifier, part: part.identifier, agent: agent.name, from: from.identifier }, "message delivered");
    return part;
  }

  async function issueView(ref: string) {
    const { ctx, issue, assigned } = await ownIssue(ref);
    const [comments, busy, files, parent, kids] = await Promise.all([
      pc.comments(issue.id),
      working(ctx),
      pc.attachments(issue.id).catch(() => []),
      issue.parentId ? pc.issueSummary(issue.parentId).catch(() => undefined) : undefined,
      // The crew works in sub-tasks of the user's task (D-45).
      issue.assigneeUserId === ctx.me ? pc.children(issue.id).catch(() => []) : Promise.resolve([] as Issue[]),
    ]);
    const crewInput = { assignees: ctx.assignees, seen: (id: string) => store.seenAt(id), working: busy.map, jobs: latestJobs(shared.runner) };
    const crew = crewOf(issue, kids, crewInput);
    // Its subtasks (D-68), each with its own crew. Their parts come from the board's lists, not a read per subtask.
    const subs = kids.filter((k) => isSubtask(k, issue) && k.status !== "cancelled").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const subParts = subs.length ? await subtaskParts(new Set(subs.map((k) => k.id))) : [];
    // Each crew member's latest word, when there's one issue to read it from (a fan-out shows its count instead):
    // what it says while working, else its last comment.
    const said = Object.fromEntries(
      await Promise.all(
        crew.map(async (m) => {
          const live = m.issues.length === 1 ? busy.map.get(m.issues[0]!.identifier) : undefined;
          if (live?.said && !live.queued) return [m.agent, { text: live.said, at: live.saidAt ?? new Date().toISOString() }];
          const c = m.issues.length === 1 ? await pc.latestComment(m.issues[0]!.id).catch(() => undefined) : undefined;
          const view = c && commentView(c, ctx.me, ctx.agents);
          return [m.agent, view && view.author.kind !== "me" ? { text: summaryOf(c.body), at: c.createdAt } : null];
        }),
      ),
    );
    store.markSeen(issue.id);
    const placement = store.placements().get(issue.id);
    const rec = store.recurring(issue.id);
    return {
      ...toCard(issue, ctx.assignees, new Date().toISOString()),
      description: displayText(issue.description),
      bucket: placement?.bucket ?? null,
      editable: assigned,
      labelIds: issue.labelIds ?? (issue.labels ?? []).map((l) => l.id),
      executor: executorOf(issue, ctx.assignees),
      replyTarget: replyTarget(issue, ctx.assignees),
      scheduled: store.schedules().get(issue.id) ?? null,
      recurring: rec ? recurringView(rec, opts.timezone) : null,
      working: busy.map.get(issue.identifier) ?? null,
      comments: comments.map((c) => commentView(c, ctx.me, ctx.agents)),
      files: fileViews(files, ctx.me),
      // An agent's sub-task links back to the task it works on (D-45).
      parent: parent ? { identifier: parent.identifier, title: parent.title } : null,
      crew: crew.map((m) => ({ ...m, said: said[m.agent] ?? null })),
      subtasks: subs.map((k) => ({
        id: k.id,
        identifier: k.identifier,
        title: k.title,
        status: k.status,
        unread: toCard(k, ctx.assignees, store.seenAt(k.id)).unread,
        crew: crewOf(k, subParts.filter((p) => p.parentId === k.id), crewInput),
      })),
    };
  }

  /** The crew parts of these subtasks: open ones, and those closed in the last 48 hours (as the board shows them). */
  async function subtaskParts(ids: Set<string>) {
    const since = new Date(Date.now() - RECENT_MS).toISOString();
    const [open, closed] = await Promise.all([pc.openIssues(), pc.closedSince(since)]);
    return [...new Map([...closed, ...open].filter((i) => i.parentId && ids.has(i.parentId) && i.assigneeAgentId).map((i) => [i.id, i])).values()];
  }

  /** Attach a file to a task (D-43); a PDF also gets its text as `<name>.txt`, for the agents. */
  async function attach(ref: string, body: unknown) {
    const { issue, assigned } = await ownIssue(ref);
    if (!assigned) throw new HttpError(403, "this task isn't yours or an assistant's");
    const input = parse(UploadSchema, body);
    const data = decode(input.data);
    if (typeof data === "string") throw new BadRequest(data);
    const name = safeName(input.name);
    const type = fileType(input.type, name);
    await pc.addAttachment(issue.id, name, type, data);
    log.info({ issue: issue.identifier, type, bytes: data.length }, "file attached");
    if (isPdf(type, name)) {
      const text = await pdfText(data);
      if (!text) log.warn({ issue: issue.identifier }, "no text in an attached PDF");
      else
        await pc
          .addAttachment(issue.id, `${name}.txt`, "text/plain", Buffer.from(text, "utf8"))
          .catch((err) => log.warn({ err: String(err.message ?? err).slice(0, 300), issue: issue.identifier }, "couldn't attach a PDF's text"));
    }
    return issueView(issue.id);
  }

  /** A task's file, for the user: downloaded, except plain images, which open in the browser. */
  async function download(res: ServerResponse, ref: string, id: string) {
    const { issue } = await ownIssue(ref);
    const file = (await pc.attachments(issue.id)).find((a) => a.id === id);
    if (!file) throw new HttpError(404, "no such file");
    const data = await pc.attachmentContent(file.id);
    const inline = INLINE_TYPES.has(file.contentType);
    const name = file.originalFilename ?? "file";
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-security-policy": "default-src 'none'; img-src 'self'; sandbox",
      "content-type": inline ? file.contentType : "application/octet-stream",
      "content-length": String(data.length),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "private, no-store",
    });
    res.end(data);
  }

  /**
   * Merge one of the user's tasks into another: its description goes into the other's word for word
   * (`mergedDescription`), its files are copied and the user's sub-tasks move over, and it's cancelled
   * with its crew. A task with an Engineer on it is refused: its workspace and branches don't move.
   */
  async function merge(ref: string, body: unknown) {
    const { into } = parse(MergeSchema, body);
    if (!REF.test(into)) throw new HttpError(400, "bad task reference");
    const { ctx, issue } = await ownIssue(ref);
    // An agent's part stands for the user's task it belongs to (D-45).
    const [source, target] = await Promise.all([userTaskOf(issue, ctx), pc.issue(into).then((i) => userTaskOf(i, ctx))]);
    if (!source || !target) throw new HttpError(403, "only your own tasks merge");
    const closed = (i: Issue) => ["done", "cancelled"].includes(i.status);
    if (source.id === target.id) throw new HttpError(400, "a task can't be merged into itself");
    if (closed(source)) throw new HttpError(409, `${source.identifier} is already closed`);
    if (closed(target)) throw new HttpError(409, `${target.identifier} is closed: reopen it first`);
    if (target.parentId === source.id) throw new HttpError(400, `${target.identifier} is part of ${source.identifier}`);
    // Subtasks go one level deep (D-68): a task with subtasks doesn't merge into a subtask.
    if (target.parentId && (await pc.children(source.id)).some((k) => isSubtask(k, source))) throw new HttpError(409, `${source.identifier} has subtasks and ${target.identifier} is a subtask: merge into ${target.identifier}'s task instead`);
    if (store.recurring(source.id)) throw new HttpError(409, `${source.identifier} repeats: stop it first`);
    const kids = await pc.children(source.id);
    const kind = (i: Issue) => ctx.assignees.find((a) => a.kind !== "me" && a.key === i.assigneeAgentId)?.kind;
    const engineers = kids.filter((k) => kind(k) === "engineer" && k.status !== "cancelled");
    if (engineers.length) {
      const names = engineers.map((k) => ctx.assignees.find((a) => a.key === k.assigneeAgentId)).map((a) => a?.persona?.name ?? a?.name ?? "an Engineer");
      throw new HttpError(409, `${source.identifier} has ${[...new Set(names)].join(" and ")}'s work on it, which can't move: merge ${target.identifier} into it instead, or dismiss the Engineer first`);
    }
    // Lists truncate descriptions; these come from single reads, so they're whole.
    const files = await pc.attachments(source.id).catch(() => []);
    for (const f of files) await pc.addAttachment(target.id, f.originalFilename ?? "file", f.contentType, await pc.attachmentContent(f.id));
    await pc.updateIssue(target.id, { description: mergedDescription(target, source) });
    for (const k of kids) if (k.assigneeUserId === ctx.me && !k.assigneeAgentId) await pc.updateIssue(k.id, { parentId: target.id });
    // The crew's parts close with the task, except one an agent is busy with (the board closes it later).
    const busy = (await working(ctx)).map;
    for (const k of kids) if (kind(k) && !closed(k) && !busy.has(k.identifier)) await pc.updateIssue(k.id, { status: "cancelled" });
    store.unschedule(source.id);
    // Cancelled first: a comment on a closed task wakes nobody, and the runner's marker keeps it from the Assistant.
    await pc.updateIssue(source.id, { status: "cancelled" });
    await pc.addComment(source.id, `Merged into ${target.identifier}.\n\n${RUNNER_MARKER}`);
    log.info({ issue: source.identifier, into: target.identifier, files: files.length }, "task merged");
    return { merged: source.identifier, into: target.identifier, files: files.length };
  }

  async function schedule(ref: string, body: unknown) {
    const { issue, assigned } = await ownIssue(ref);
    if (!assigned) throw new HttpError(403, "this task isn't yours or an assistant's");
    const result = scheduleMove(store, issue, parse(ScheduleSchema, body), opts.timezone);
    log.info({ issue: issue.identifier, scheduled: result.scheduled, movedNow: result.movedNow }, "move scheduled");
    return { identifier: issue.identifier, ...result };
  }

  async function recurringChange(ref: string, body: unknown) {
    const { ctx, issue, assigned } = await ownIssue(ref);
    if (!assigned) throw new HttpError(403, "this task isn't yours or an assistant's");
    const recurring = await changeRecurring(pc, store, ctx, issue, parse(RecurringSchema, body), opts.timezone, log);
    return { identifier: issue.identifier, recurring };
  }

  // Memory (D-61): recall, search, remember and propose for the agents; the Memory view; past tasks.
  const mem = memoryRoutes({ paperclip: pc, memory: store.memory, log, fail: (status, message) => new HttpError(status, message) });
  // Stats (D-62): the runner's per-job usage, and the Stats view.
  const statsApi = statsRoutes({ paperclip: pc, stats: store.stats, memory: store.memory, timezone: opts.timezone, log });

  // The tasks bridge (Assistant tools) and the runner (recurring runs), with the internal token (D-25).
  const internal: typeof routes = [
    { method: "POST", path: /^\/internal\/issues\/([^/]+)\/schedule$/, handle: async (m, body) => schedule(decodeURIComponent(m[1]!), body) },
    { method: "POST", path: /^\/internal\/issues\/([^/]+)\/recurring$/, handle: async (m, body) => recurringChange(decodeURIComponent(m[1]!), body) },
    { method: "POST", path: /^\/internal\/issues\/([^/]+)\/merge$/, handle: async (m, body) => merge(decodeURIComponent(m[1]!), body) },
    {
      method: "POST",
      path: /^\/internal\/recurring\/claim$/,
      handle: async () => {
        const ctx = await context();
        return { runs: await claimDue(pc, store, ctx, opts.timezone, log) };
      },
    },
    {
      method: "POST",
      path: /^\/internal\/recurring\/runs\/([0-9a-f-]{36})\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})$/,
      handle: async (m, body) => {
        const { state } = parse(RunStateSchema, body);
        if (!store.setRunState(m[1]!, m[2]!, state)) throw new HttpError(404, "no such run");
        log.info({ definition: m[1], occurrence: m[2], state }, "recurring run updated");
        return { ok: true };
      },
    },
    {
      // An agent passes one of the user's messages on to another agent on the same task (D-54). Only the
      // user's own comment travels, word for word: the agent picks which one and for whom, never the words.
      method: "POST",
      path: /^\/internal\/issues\/([^/]+)\/pass$/,
      handle: async (m, body) => {
        const { comment, to, by } = parse(PassSchema, body);
        const { ctx, issue } = await ownIssue(decodeURIComponent(m[1]!));
        const task = await userTaskOf(issue, ctx);
        if (!task) throw new HttpError(400, "only on the user's tasks and their agents' parts");
        const c = (await pc.comments(issue.id)).find((x) => x.id === comment && !x.deletedAt);
        if (!c || c.authorType !== "user" || c.authorUserId !== ctx.me || c.body.includes(RUNNER_MARKER)) throw new HttpError(400, "pass on a comment the user wrote on this task");
        const agent = ctx.assignees.find((a) => a.kind !== "me" && (a.persona?.name.toLowerCase() === to.toLowerCase() || a.key === to));
        if (!agent) throw new HttpError(400, `no agent is called ${to}: ${ctx.assignees.flatMap((a) => (a.persona ? [a.persona.name] : [])).join(", ")}`);
        if (agent.key === issue.assigneeAgentId) throw new HttpError(400, `this is ${agent.persona?.name ?? agent.name}'s own chat`);
        const key = `passed:${c.id}:${agent.key}`;
        if (store.meta(key)) return { passed: false, reason: `already passed on to ${agent.persona?.name ?? agent.name}` };
        // A message already delivered here keeps pointing at the chat it was written in.
        const origin = deliveredFrom(c.body) ?? { identifier: issue.identifier, commentId: c.id };
        const sender = ctx.assignees.find((a) => a.kind !== "me" && a.persona?.name.toLowerCase() === by?.toLowerCase())?.persona?.name;
        const part = await deliver(ctx, task, agent, displayText(c.body).replace(/\n\n_(Written in|Passed on by) [^\n]*_$/, ""), { ...origin, note: `Passed on by ${sender ?? "an agent"} from ${issue.identifier}.` });
        store.setMeta(key, new Date().toISOString());
        return { passed: true, to: agent.persona?.name ?? agent.name, part: part.identifier };
      },
    },
    {
      // The runner's Engineer jobs: running, queued and recently finished (kept in memory only).
      method: "POST",
      path: /^\/internal\/runner\/activity$/,
      handle: async (_m, body) => {
        shared.runner = { ...parse(RunnerReportSchema, body), at: new Date().toISOString() };
        // Settings asked for a fresh check of the laptop's sign-ins (Check now).
        const checkConnections = Boolean(shared.checkHost);
        shared.checkHost = false;
        return { ok: true, ...(checkConnections ? { checkConnections } : {}) };
      },
    },
    {
      // The runner's long poll for sign-ins started in Settings (D-66): what it reports in, commands out.
      method: "POST",
      path: /^\/internal\/runner\/signins$/,
      handle: async (_m, body) => {
        const { updates, wait } = parse(RunnerPollSchema, body);
        return { commands: await signins.poll(updates, wait === false ? 0 : 25_000) };
      },
    },
    {
      // The runner's checks of the sign-ins made on the laptop (GitHub, Google Cloud, AWS, Primer, engines), for Settings.
      method: "POST",
      path: /^\/internal\/runner\/connections$/,
      handle: async (_m, body) => {
        shared.host = { ...parse(HostReportSchema, body), at: new Date().toISOString() };
        return { ok: true };
      },
    },
    {
      // Margaret's view of the board (D-76): every column, top to bottom, each card with where it came from,
      // its crew and the start of its description. The tasks bridge checks that only Margaret asks.
      method: "POST",
      path: /^\/internal\/supervisor\/board$/,
      handle: async () => {
        const { open, board } = await boardSnapshot();
        const byId = new Map(open.map((i) => [i.id, i]));
        return { columns: supervisorView(board.buckets, byId), recent: supervisorAssignments(store) };
      },
    },
    {
      // Margaret assigns (D-76): one crew member on one of the user's tasks, with instructions and a reason,
      // as a part marked as hers. The rules are here, not in her prompt.
      method: "POST",
      path: /^\/internal\/supervisor\/assign$/,
      handle: async (_m, body) => {
        const input = parse(SupervisorAssignSchema, body);
        const { ctx, issue } = await ownIssue(input.task);
        if (!usersOwn(issue, ctx) || closedIssue(issue)) throw new HttpError(400, "only the user's open tasks");
        const refusal = supervisorRefusal({ issue, agentName: input.agent, assignees: ctx.assignees, parts: await pc.children(issue.id), recent: supervisorAssignments(store) });
        if (refusal) throw new HttpError(400, refusal);
        const agent = ctx.assignees.find((a) => a.persona?.name.toLowerCase() === input.agent.toLowerCase())!;
        const part = await addToCrew(ctx, issue, agent, supervisorInstructions(input.instructions, input.why), {}, SUPERVISOR_MARKER);
        recordSupervisorAssignment(store, { task: issue.identifier, part: part.identifier, partId: part.id, agent: agent.persona?.name ?? agent.name, at: new Date().toISOString() });
        log.info({ issue: issue.identifier, part: part.identifier, agent: agent.name }, "supervisor assigned");
        return { assigned: true, part: part.identifier, agent: agent.persona?.name ?? agent.name };
      },
    },
    {
      // The automation switch (D-75): the runner sends its config's default and gets what applies.
      method: "POST",
      path: /^\/internal\/runner\/automation$/,
      handle: async (_m, body) => {
        const reported = AutomationSchema.safeParse((body as { default?: unknown } | null)?.default);
        if (reported.success) shared.automationDefault = reported.data;
        const stored = storedAutomation(store);
        return { automation: stored ?? (reported.success ? reported.data : AUTOMATION_OFF), source: stored ? "settings" : "config" };
      },
    },
    ...mem.internal,
    ...statsApi.internal,
  ];

  const mode = opts.mode ?? "local";
  let failedPairings: number[] = [];

  // Pairing a phone (D-23): the laptop makes a one-time link, the phone spends it for a session cookie.
  const pairing: { method: string; path: RegExp; localOnly?: boolean; open?: boolean; handle: (m: RegExpMatchArray, body: unknown, req: IncomingMessage, res: ServerResponse) => Promise<unknown> }[] = [
    {
      method: "GET",
      path: /^\/api\/session$/,
      open: true,
      handle: async (_m, _b, req) => ({ mode, paired: mode === "local" || store.checkSession(sessionToken(req)), lan: mode === "local" ? (opts.lan ? { url: opts.lan.url } : null) : undefined }),
    },
    {
      method: "POST",
      path: /^\/api\/pairing$/,
      localOnly: true,
      handle: async () => {
        if (!opts.lan) throw new HttpError(409, "LAN access is off (set BOARD_LAN_CLIENTS)");
        const p = store.createPairing();
        log.info("pairing link created");
        return { url: `${opts.lan.url}/#/pair/${p.code}`, base: opts.lan.url, code: p.code, expiresAt: p.expiresAt };
      },
    },
    { method: "GET", path: /^\/api\/devices$/, localOnly: true, handle: async () => store.devices() },
    {
      method: "DELETE",
      path: /^\/api\/devices\/([0-9a-f]{16})$/,
      localOnly: true,
      handle: async (m) => {
        if (!store.revokeDevice(m[1]!)) throw new HttpError(404, "no such device");
        log.info({ device: m[1] }, "device revoked");
        return { ok: true };
      },
    },
    {
      // Signing one Atlassian account out of Jira (D-69), from Settings on the laptop only, like signing in.
      method: "DELETE",
      path: /^\/api\/connections\/jira\/accounts\/([a-z0-9]{1,32})$/,
      localOnly: true,
      handle: async (m) => {
        if (!opts.jira) throw new HttpError(404, "Jira sign-in isn't set up on the board (no jira_auth_token)");
        try {
          await opts.jira.remove(m[1]!);
        } catch (err) {
          if (err instanceof McpAuthFailed) throw new HttpError(404, err.message);
          throw err;
        }
        log.info({ account: m[1] }, "Jira account removed");
        return { ok: true };
      },
    },
    // Signing in to Telegram (D-37): phone, code, then 2FA password. On the laptop only, like Google's
    // Reconnect: what's typed here signs in to the account, so never from a phone on the LAN.
    ...(["start", "code", "password"] as const).map((step) => ({
      method: "POST",
      path: new RegExp(`^/api/telegram/${step}$`),
      localOnly: true,
      handle: async (_m: RegExpMatchArray, body: unknown, req: IncomingMessage) => {
        if (!opts.telegram) throw new HttpError(404, "Telegram sign-in isn't set up on the board (no telegram_auth_token)");
        if (!loopbackPort(req.headers.host)) throw new HttpError(403, "sign in to Telegram from the board on your computer (http://127.0.0.1:3120)");
        try {
          if (step === "start") return await opts.telegram.start(parse(z.object({ phone: z.string().min(6).max(30) }).strict(), body).phone);
          if (step === "code") {
            const a = parse(z.object({ login_id: z.string().max(64), code: z.string().min(4).max(10) }).strict(), body);
            return await opts.telegram.code(a.login_id, a.code);
          }
          const a = parse(z.object({ login_id: z.string().max(64), password: z.string().min(1).max(256) }).strict(), body);
          return await opts.telegram.password(a.login_id, a.password);
        } catch (err) {
          if (err instanceof TelegramAuthFailed) throw new HttpError(400, err.message);
          throw err;
        }
      },
    })),
    {
      method: "POST",
      path: /^\/api\/pair$/,
      open: true,
      handle: async (_m, body, _req, res) => {
        if (mode !== "lan") throw new HttpError(400, "pair from the phone, at the LAN address");
        const now = Date.now();
        failedPairings = failedPairings.filter((t) => now - t < 10 * 60_000);
        if (failedPairings.length >= 10) throw new HttpError(429, "too many attempts; make a new pairing link in a few minutes");
        const { code, device } = parse(z.object({ code: z.string().min(8).max(64), device: z.string().max(200).default("") }).strict(), body);
        const token = store.pair(code, device);
        if (!token) {
          failedPairings.push(now);
          throw new HttpError(403, "this pairing link is invalid, used or expired; make a new one on the laptop");
        }
        log.info({ device: device.slice(0, 80) }, "device paired");
        res.setHeader("set-cookie", `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
        return { ok: true };
      },
    },
  ];

  const connectionFlows = new Map<string, { state: string; expires: number }>();
  async function connectionsNow(maxAgeMs: number) {
    const ask = <T,>(p: Promise<T> | undefined) => (p ? p.then((v) => v ?? null, () => null) : Promise.resolve(undefined));
    const [google, telegram, slack, whatsapp, glean, grafana, clickhouse, cloudflare, jira, primer] = await Promise.all([
      ask(opts.google?.status(maxAgeMs)),
      ask(opts.telegram?.status(maxAgeMs)),
      ask(opts.slackAuth?.call("GET", "status") as Promise<{ configured?: boolean; connected?: boolean }> | undefined),
      ask(opts.whatsapp?.call("GET", "status") as Promise<{ state?: string }> | undefined),
      ask(opts.glean?.status(maxAgeMs)),
      ask(opts.grafana?.status(maxAgeMs)),
      ask(opts.clickhouse?.status(maxAgeMs)),
      ask(opts.cloudflare?.status(maxAgeMs)),
      ask(opts.jira?.status(maxAgeMs)),
      ask(opts.primer?.status(maxAgeMs)),
    ]);
    const proxies = Object.fromEntries(Object.entries({ glean, grafana, clickhouse, cloudflare, jira, primer }).filter(([, v]) => v !== undefined));
    // After a board restart there's no report from the laptop yet: ask for one (the runner answers within 30 seconds).
    if (!shared.host) shared.checkHost = true;
    return {
      hiddenBanners: store.hiddenBanners(),
      connections: connectionsView({ google, googleEnabled: Boolean(opts.google), telegram, telegramEnabled: Boolean(opts.telegram), slack, slackEnabled: Boolean(opts.slackAuth), whatsapp, whatsappEnabled: Boolean(opts.whatsapp), proxies, host: shared.host }),
      checking: Boolean(shared.checkHost),
      runnerSeenAt: shared.runner?.at ?? null,
    };
  }
  const routes: { method: string; path: RegExp; maxBody?: number; handle: (m: RegExpMatchArray, body: unknown, url: URL, req: IncomingMessage) => Promise<unknown> }[] = [
    {
      // The automation switch for Settings (D-75): what the user set here, else the runner's config, else off.
      method: "GET", path: /^\/api\/automation$/,
      handle: async () => {
        const stored = storedAutomation(store);
        return { automation: stored ?? shared.automationDefault ?? AUTOMATION_OFF, source: stored ? "settings" : shared.automationDefault ? "config" : "default", runnerSeenAt: shared.runner?.at ?? null };
      },
    },
    {
      method: "POST", path: /^\/api\/automation$/,
      handle: async (_m, body) => ({ automation: saveAutomation(store, parse(AutomationSchema, body)), source: "settings", runnerSeenAt: shared.runner?.at ?? null }),
    },
    {
      // Every connection, for Settings: board sign-ins from their proxies, the laptop's from the runner's last check.
      method: "GET", path: /^\/api\/connections$/,
      handle: async () => connectionsNow(60_000),
    },
    {
      // Sign-ins on the laptop, run by the runner and driven from here (D-66).
      method: "GET", path: new RegExp(`^/api/connections/signin/(${SIGNIN_PROVIDERS.join("|")})$`),
      handle: async (m) => ({ session: signins.get(m[1] as SignInProvider) ?? null, runnerOnline: signins.runnerOnline() }),
    },
    {
      method: "POST", path: new RegExp(`^/api/connections/signin/(${SIGNIN_PROVIDERS.join("|")})$`),
      handle: async (m) => {
        if (!signins.runnerOnline()) throw new HttpError(503, "The runner on the laptop isn't answering, so it can't start this sign-in. Check that pennyworth-runner is running.");
        return { session: signins.start(m[1] as SignInProvider) };
      },
    },
    {
      method: "POST", path: new RegExp(`^/api/connections/signin/(${SIGNIN_PROVIDERS.join("|")})/input$`),
      handle: async (m, body) => {
        const { text } = parse(z.object({ text: z.string().trim().min(1).max(4096) }).strict(), body);
        try {
          return { session: signins.input(m[1] as SignInProvider, text) };
        } catch (err) {
          throw new HttpError(409, (err as Error).message);
        }
      },
    },
    {
      method: "POST", path: new RegExp(`^/api/connections/signin/(${SIGNIN_PROVIDERS.join("|")})/cancel$`),
      handle: async (m) => ({ session: signins.cancel(m[1] as SignInProvider) ?? null }),
    },
    {
      // Hide a connection's banner while its state lasts, or show it again (D-67).
      method: "POST", path: /^\/api\/banners\/(google|telegram|glean|grafana|clickhouse|cloudflare|jira|primer)\/(hide|show)$/,
      handle: async (m, body) => {
        if (m[2] === "show") store.hideBanner(m[1]!, null);
        else store.hideBanner(m[1]!, parse(z.object({ since: z.string().min(1).max(4000) }).strict(), body).since);
        return { hiddenBanners: store.hiddenBanners() };
      },
    },
    {
      method: "POST", path: /^\/api\/connections\/check$/,
      handle: async () => {
        shared.checkHost = true;
        return connectionsNow(0);
      },
    },
    {
      method: "GET", path: /^\/api\/connections\/(google|slack)\/status$/,
      handle: async (m) => {
        if (m[1] === "google") return { enabled: Boolean(opts.google), ...(await opts.google?.status(0)) };
        return opts.slackAuth ? { enabled: true, ...await opts.slackAuth.call("GET", "status") as object } : { enabled: false };
      },
    },
    {
      method: "POST", path: /^\/api\/connections\/(google|slack)\/configure$/,
      handle: async (m, body) => {
        const data = parse(z.object({ client_id: z.string().min(5).max(500), client_secret: z.string().min(1).max(500).optional() }).strict(), body);
        try {
          if (m[1] === "google" && opts.google && data.client_secret) return await opts.google.configure(data.client_id, data.client_secret);
          if (m[1] === "slack" && opts.slackAuth) return await opts.slackAuth.call("POST", "configure", { client_id: data.client_id });
        } catch { throw new HttpError(400, "Client configuration could not be saved. Existing clients must be changed on the server."); }
        throw new HttpError(400, "Connection service or client credentials are missing");
      },
    },
    {
      method: "POST", path: /^\/api\/connections\/(google|slack)\/(start|finish)$/,
      handle: async (m, body, _url, req) => {
        const provider = m[1]!, action = m[2]!;
        const key = `${sessionToken(req) || "local"}:${provider}`;
        if ((provider === "google" && !opts.google) || (provider === "slack" && !opts.slackAuth)) throw new HttpError(400, "Connection is not configured on this server");
        try {
          if (action === "start") {
            const data = parse(z.object({ account: z.string().email().max(320).optional() }).strict(), body);
            if (provider === "google" && !data.account) throw new HttpError(400, "Enter your Google email address");
            const result = provider === "google" ? await opts.google!.start(data.account!, "http://localhost:3120/google/callback", true) : await opts.slackAuth!.call("POST", "start", {}) as { url: string };
            const state = new URL(result.url).searchParams.get("state");
            if (!state) throw new Error("Missing sign-in state");
            for (const [k, v] of connectionFlows) if (v.expires < Date.now()) connectionFlows.delete(k);
            connectionFlows.set(key, { state, expires: Date.now() + 600_000 });
            return result;
          }
          const { callback } = parse(z.object({ callback: z.string().url().max(4096) }).strict(), body);
          const url = new URL(callback);
          const expected = provider === "google" ? "http://localhost:3120/google/callback" : "http://localhost:3118/callback";
          const pending = connectionFlows.get(key);
          if (url.origin + url.pathname !== expected || !pending || pending.expires < Date.now() || pending.state !== url.searchParams.get("state")) throw new HttpError(400, "This callback does not match your sign-in. Start again.");
          const code = url.searchParams.get("code");
          if (!code || code.length > 2000) throw new HttpError(400, "Access was not granted. Start sign-in again.");
          connectionFlows.delete(key);
          return provider === "google" ? await opts.google!.finish(pending.state, code) : await opts.slackAuth!.call("POST", "finish", { state: pending.state, code });
        } catch (err) {
          if (err instanceof HttpError) throw err;
          if (err instanceof SlackConnectionError) throw new HttpError(400, err.message);
          throw new HttpError(400, provider === "google" ? "Google sign-in failed. Check the OAuth client configuration and try again." : "Slack sign-in failed. Check SLACK_CLIENT_ID and try again.");
        }
      },
    },
    ...([['GET','status'],['GET','chats'],['PUT','chats'],['POST','connect'],['POST','disconnect']] as const).map(([method,path]) => ({
      method, path: new RegExp(`^/api/whatsapp/${path}$`),
      handle: async (_m: RegExpMatchArray, body: unknown) => {
        if (!opts.whatsapp) throw new HttpError(404, 'WhatsApp is not configured');
        const data = method === 'PUT' ? parse(z.object({ ids: z.array(z.string().min(1).max(200)).max(1000) }).strict(), body) : undefined;
        try { return await opts.whatsapp.call(method, path, data); }
        catch { throw new HttpError(502, 'WhatsApp is unavailable; try again shortly'); }
      },
    })),
    {
      method: "GET",
      path: /^\/api\/board$/,
      handle: async () => {
        const { ctx, open, board, busy } = await boardSnapshot();
        const [google, telegram, glean, grafana, clickhouse, cloudflare, jira] = await Promise.all([opts.google?.status(), opts.telegram?.status(), opts.glean?.status(), opts.grafana?.status(), opts.clickhouse?.status(), opts.cloudflare?.status(), opts.jira?.status()]);
        // Lists truncate long descriptions; the brief is read in full.
        const brief = open.find((i) => i.id === board.brief?.id);
        if (board.brief && brief?.descriptionTruncated) board.brief.description = displayText((await pc.issue(brief.id)).description);
        // When Tomorrow next rolls into Today: the next calendar day, except before days off.
        const today = localDate(opts.timezone);
        const rollsOn = nextWorkday(today, opts.workdays ?? WORKWEEK);
        return { ...board, assignees: ctx.assignees, labels: ctx.labels, prefix: ctx.prefix, timezone: opts.timezone, slackTeams: opts.slackTeams ?? {}, rollsOn, rollsTomorrow: rollsOn === addDays(today, 1), buckets: board.buckets, agentsActive: busy.active, google: google ?? null, telegram: telegram ?? null, glean: glean ?? null, grafana: grafana ?? null, clickhouse: clickhouse ?? null, cloudflare: cloudflare ?? null, jira: jira ?? null, hiddenBanners: store.hiddenBanners(), backup: opts.backupStatus ? readBackup(opts.backupStatus) : null };
      },
    },
    { method: "GET", path: /^\/api\/issues\/([^/]+)$/, handle: async (m) => issueView(decodeURIComponent(m[1]!)) },
    { method: "GET", path: /^\/api\/agents$/, handle: async () => activity(await context(), true) },
    {
      method: "PATCH",
      path: /^\/api\/issues\/([^/]+)$/,
      handle: async (m, body) => {
        const { ctx, issue, assigned } = await ownIssue(decodeURIComponent(m[1]!));
        if (!assigned) throw new HttpError(403, "this task isn't yours or an assistant's");
        const update = parse(UpdateSchema, body);
        const patch = paperclipUpdate(issue, update, ctx);
        if (Object.keys(patch).length) await pc.updateIssue(issue.id, patch);
        log.info({ issue: issue.identifier, fields: Object.keys(patch) }, "task updated");
        // Done or cancelled closes the crew's open parts too, except one an agent is busy with (D-45).
        if ((update.status === "done" || update.status === "cancelled") && issue.assigneeUserId === ctx.me) {
          const [kids, busy] = await Promise.all([pc.children(issue.id), working(ctx)]);
          const isCrew = (k: Issue) => ctx.assignees.some((a) => a.kind !== "me" && a.key === k.assigneeAgentId);
          // Open subtasks close too when the user says so (D-68), with their crew; otherwise they're cards again.
          const subs = update.subtasks === "close" ? kids.filter((k) => isSubtask(k, issue) && !closedIssue(k)) : [];
          const parts = [...kids.filter(isCrew), ...(await Promise.all(subs.map((k) => pc.children(k.id)))).flat().filter(isCrew)];
          for (const k of parts) {
            if (closedIssue(k) || busy.map.has(k.identifier)) continue;
            await pc.updateIssue(k.id, { status: update.status });
          }
          for (const k of subs) await pc.updateIssue(k.id, { status: update.status });
          if (subs.length) log.info({ issue: issue.identifier, subtasks: subs.length, status: update.status }, "subtasks closed with their task");
          counts.delete(issue.id);
        }
        return issueView(issue.id);
      },
    },
    {
      method: "POST",
      path: /^\/api\/issues\/([^/]+)\/comments$/,
      handle: async (m, body) => {
        const { ctx, issue, assigned } = await ownIssue(decodeURIComponent(m[1]!));
        if (!assigned) throw new HttpError(403, "this task isn't yours or an assistant's");
        const { body: text } = parse(z.object({ body: z.string().trim().min(1).max(30_000) }).strict(), body);
        // @-mentions (D-54): the agents named, other than the one this chat is with, get the message on their part.
        const task = await userTaskOf(issue, ctx);
        const own = issue.id === task?.id ? ctx.assignees.find((a) => a.kind === "assistant")?.key : issue.assigneeAgentId;
        const named = task ? mentionedAgents(text, ctx.assignees) : [];
        const others = named.filter((a) => a.key !== own);
        // Hidden markers are machine-only: the runner ignores comments that carry its marker.
        let posted;
        if (!others.length || named.length > others.length) posted = await pc.addComment(issue.id, displayText(text));
        // On the user's own task the message stays in the team chat; the Assistant leaves it to the others.
        else if (issue.id === task!.id) posted = await pc.addComment(issue.id, `${displayText(text)}\n\n${FOR_OTHERS}`);
        log.info({ issue: issue.identifier, mentions: named.map((a) => a.name) }, "comment added");
        const where = issue.id === task?.id ? "the team chat" : `${ctx.assignees.find((a) => a.key === issue.assigneeAgentId)?.persona?.name ?? "another agent"}'s chat`;
        const parts = [];
        for (const a of others) parts.push(await deliver(ctx, task!, a, text, { identifier: issue.identifier, commentId: posted?.id, note: `Written in ${where} on ${issue.identifier}.` }));
        // A message that left this chat for another agent's: the board opens that one.
        return { ...(await issueView(issue.id)), ...(!posted && parts[0] ? { movedTo: parts[0].identifier } : {}) };
      },
    },
    {
      // Bring an agent onto one of your tasks (D-45): a sub-task assigned to it, with your instructions.
      method: "POST",
      path: /^\/api\/issues\/([^/]+)\/agents$/,
      handle: async (m, body) => {
        const { ctx, issue } = await ownIssue(decodeURIComponent(m[1]!));
        if (issue.assigneeUserId !== ctx.me) throw new HttpError(403, "agents join your own tasks");
        const input = parse(AddAgentSchema, body);
        const agent = ctx.assignees.find((a) => a.key === input.agent && a.kind !== "me");
        if (!agent) throw new HttpError(400, "unknown agent");
        await addToCrew(ctx, issue, agent, input.instructions, { engine: input.engine, model: input.model, effort: input.effort });
        return issueView(issue.id);
      },
    },
    {
      // A subtask of one of your tasks (D-68): yours, folded into the task; agents join it as they join any task.
      method: "POST",
      path: /^\/api\/issues\/([^/]+)\/subtasks$/,
      handle: async (m, body) => {
        const { ctx, issue } = await ownIssue(decodeURIComponent(m[1]!));
        await subtaskParent(ctx, issue);
        const input = parse(SubtaskSchema, body);
        const todo = ctx.labels.find((l) => l.name === "todo");
        const sub = await pc.createIssue({
          title: input.title,
          description: displayText(input.description),
          status: "todo",
          priority: issue.priority,
          parentId: issue.id,
          assigneeUserId: ctx.me,
          allowDuplicate: true,
          ...(todo ? { labelIds: [todo.id] } : {}),
        });
        store.markSeen(sub.id, new Date(Date.now() + 5_000).toISOString());
        counts.delete(issue.id);
        log.info({ issue: issue.identifier, subtask: sub.identifier }, "subtask added");
        return issueView(issue.id);
      },
    },
    {
      // One agent, one set of instructions, on several subtasks (D-68): a part on each, as Add agent makes.
      method: "POST",
      path: /^\/api\/issues\/([^/]+)\/subtasks\/agents$/,
      handle: async (m, body) => {
        const { ctx, issue } = await ownIssue(decodeURIComponent(m[1]!));
        if (!usersOwn(issue, ctx)) throw new HttpError(403, "agents join your own tasks");
        const input = parse(AssignSubtasksSchema, body);
        const agent = ctx.assignees.find((a) => a.key === input.agent && a.kind !== "me");
        if (!agent) throw new HttpError(400, "unknown agent");
        const open = new Map((await pc.children(issue.id)).filter((k) => isSubtask(k, issue) && !closedIssue(k)).map((k) => [k.id, k]));
        const subs = [...new Set(input.subtasks)].map((id) => open.get(id));
        if (subs.some((k) => !k)) throw new HttpError(400, "pick open subtasks of this task");
        for (const k of subs) await addToCrew(ctx, k!, agent, input.instructions, { engine: input.engine, model: input.model, effort: input.effort });
        log.info({ issue: issue.identifier, agent: agent.name, subtasks: subs.length }, "agent on subtasks");
        return issueView(issue.id);
      },
    },
    {
      // Make a task a subtask of another, or move a subtask back to the board (D-68).
      method: "POST",
      path: /^\/api\/issues\/([^/]+)\/parent$/,
      handle: async (m, body) => {
        const { ctx, issue } = await ownIssue(decodeURIComponent(m[1]!));
        if (!usersOwn(issue, ctx)) throw new HttpError(403, "only your own tasks");
        const { parent } = parse(ParentSchema, body);
        if (parent === null) {
          const from = issue.parentId ? await pc.issue(issue.parentId) : undefined;
          if (!from || !isSubtask(issue, from)) throw new HttpError(400, `${issue.identifier} isn't a subtask`);
          await pc.updateIssue(issue.id, { parentId: null });
          store.move(issue.id, "triage", "top");
          counts.delete(from.id);
          log.info({ issue: issue.identifier, from: from.identifier }, "subtask moved to the board");
          return issueView(issue.id);
        }
        if (issue.parentId) throw new HttpError(400, `${issue.identifier} is already part of another task`);
        if (closedIssue(issue)) throw new HttpError(409, `${issue.identifier} is closed`);
        if (store.recurring(issue.id)) throw new HttpError(409, `${issue.identifier} repeats: stop it first`);
        const target = await pc.issue(parent);
        if (target.id === issue.id) throw new HttpError(400, "a task can't be its own subtask");
        await subtaskParent(ctx, target);
        if ((await pc.children(issue.id)).some((k) => usersOwn(k, ctx))) throw new HttpError(409, `${issue.identifier} has subtasks of its own: subtasks go one level deep`);
        await pc.updateIssue(issue.id, { parentId: target.id });
        store.unschedule(issue.id);
        counts.delete(target.id);
        log.info({ issue: issue.identifier, into: target.identifier }, "made a subtask");
        return issueView(issue.id);
      },
    },
    {
      // A stuck agent's part goes to another (D-45): the user's instructions, plus a note that someone tried first.
      method: "POST",
      path: /^\/api\/issues\/([^/]+)\/handover$/,
      handle: async (m, body) => {
        const { ctx, issue } = await ownIssue(decodeURIComponent(m[1]!));
        if (issue.assigneeUserId !== ctx.me) throw new HttpError(403, "only your own tasks");
        const { from, to } = parse(HandOverSchema, body);
        if (!REF.test(from)) throw new HttpError(400, "bad task reference");
        const part = await pc.issue(from);
        if (part.parentId !== issue.id) throw new HttpError(400, "that isn't part of this task");
        // Only the user's own words travel as instructions: an agent's proposal needs approving first.
        if (!part.createdByUserId || part.createdByAgentId) throw new HttpError(400, "these instructions came from an agent, not from you: add the agent with your own instead");
        const fromAgent = ctx.assignees.find((a) => a.key === part.assigneeAgentId);
        const agent = ctx.assignees.find((a) => a.key === to && a.kind !== "me");
        if (!agent || !fromAgent || agent.key === fromAgent.key) throw new HttpError(400, "pick another agent");
        await addToCrew(ctx, issue, agent, handOverText(displayText(part.description), fromAgent.persona?.name ?? fromAgent.name), {});
        // A status change wakes nobody: a comment here would read as an instruction to the runner.
        await pc.updateIssue(part.id, { status: "cancelled" });
        log.info({ issue: issue.identifier, from: part.identifier, to: agent.name }, "handed over");
        return issueView(issue.id);
      },
    },
    { method: "POST", path: /^\/api\/issues\/([^/]+)\/files$/, maxBody: MAX_UPLOAD_BODY + 1024, handle: async (m, body) => attach(decodeURIComponent(m[1]!), body) },
    {
      method: "POST",
      path: /^\/api\/issues\/([^/]+)\/move$/,
      handle: async (m, body) => {
        const { issue, assigned } = await ownIssue(decodeURIComponent(m[1]!));
        if (!assigned) throw new HttpError(403, "this task isn't yours or an assistant's");
        const { bucket, position } = parse(z.object({ bucket: z.enum(BUCKETS), position: z.enum(["top", "bottom"]).default("top") }).strict(), body);
        store.move(issue.id, bucket, position);
        return { ok: true };
      },
    },
    { method: "POST", path: /^\/api\/issues\/([^/]+)\/schedule$/, handle: async (m, body) => schedule(decodeURIComponent(m[1]!), body) },
    { method: "POST", path: /^\/api\/issues\/([^/]+)\/recurring$/, handle: async (m, body) => recurringChange(decodeURIComponent(m[1]!), body) },
    { method: "POST", path: /^\/api\/issues\/([^/]+)\/merge$/, handle: async (m, body) => merge(decodeURIComponent(m[1]!), body) },
    {
      method: "PUT",
      path: /^\/api\/buckets\/([a-z]+)$/,
      handle: async (m, body) => {
        const bucket = m[1];
        if (!isBucket(bucket)) throw new HttpError(404, "no such bucket");
        const { ids } = parse(z.object({ ids: z.array(z.string().regex(/^[0-9a-f-]{36}$/)).max(1000) }).strict(), body);
        // Only tasks the board shows can be ranked.
        const ctx = await context();
        const open = new Set(mine(await pc.openIssues(), ctx).map((i) => i.id));
        store.setOrder(bucket, ids.filter((id) => open.has(id)));
        return { ok: true };
      },
    },
    {
      method: "POST",
      path: /^\/api\/buckets\/today\/carried$/,
      handle: async (_m, body) => {
        // Today's carried-over tasks, all at once (D-28): keep them for today, or move them on.
        const { action } = parse(z.object({ action: z.enum(["keep", "tomorrow", "later"]) }).strict(), body);
        if (action === "keep") return { ok: true, count: store.keepCarried() };
        const ctx = await context();
        const open = new Set(mine(await pc.openIssues(), ctx).map((i) => i.id));
        const ids = store.carried().filter((id) => open.has(id));
        store.moveAll(ids, action);
        log.info({ moved: ids.length, to: action }, "carried-over tasks moved");
        return { ok: true, count: ids.length };
      },
    },
    {
      method: "POST",
      path: /^\/api\/issues$/,
      handle: async (_m, body) => {
        const input = parse(CreateSchema, body);
        const ctx = await context();
        const todo = ctx.labels.find((l) => l.name === "todo");
        const issue = await pc.createIssue({
          title: input.title,
          description: input.description,
          status: "todo",
          priority: "medium",
          assigneeUserId: ctx.me,
          ...(todo ? { labelIds: [todo.id] } : {}),
        });
        store.move(issue.id, input.bucket, "top");
        store.markSeen(issue.id, new Date(Date.now() + 5_000).toISOString());
        log.info({ issue: issue.identifier, bucket: input.bucket }, "task created");
        return { id: issue.id, identifier: issue.identifier };
      },
    },
    {
      // Status and title of tasks referenced in text ("PEN-12"), so links show whether they're done.
      method: "GET",
      path: /^\/api\/refs$/,
      handle: async (_m, _body, url) => {
        const ids = [...new Set((url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim().toUpperCase()))].filter((s) => /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/.test(s)).slice(0, 100);
        const out: Record<string, { status: string; title: string }> = {};
        for (let i = 0; i < ids.length; i += 6) {
          await Promise.all(
            ids.slice(i, i + 6).map(async (id) => {
              const ref = await refCache(id);
              if (ref) out[id] = ref;
            }),
          );
        }
        return out;
      },
    },
    {
      method: "GET",
      // The models and efforts a crew member can run with on an engine (?engine=, default its role's).
      path: /^\/api\/models\/([0-9a-f-]{36})$/,
      handle: async (m, _body, url) => {
        const ctx = await context();
        const a = ctx.assignees.find((x) => x.key === m[1] && x.kind !== "me");
        if (!a?.engine) throw new HttpError(404, "not on the crew");
        const asked = url?.searchParams.get("engine") ?? a.engine;
        const engine = (a.engines ?? [a.engine]).find((e) => e === asked);
        if (!engine) throw new HttpError(400, `${a.persona?.name ?? a.name} runs on ${(a.engines ?? [a.engine]).join(", ")}`);
        let listed = (await pc.models(ENGINE_ADAPTER[engine]).catch(() => [])).map((x) => x.id);
        if (engine === "openrouter") listed = listed.filter((x) => x.startsWith("openrouter/"));
        const own = engine === a.engine ? a.defaultModel : undefined;
        const models = [...new Set([...(own ? [own] : []), ...(a.catalog?.[engine] ?? []), ...listed])];
        return { engine, default: own ?? null, defaultEffort: engine === a.engine ? (a.defaultEffort ?? null) : null, models, efforts: EFFORTS[engine] };
      },
    },
    ...mem.api,
    ...statsApi.api,
  ];

  // Referenced tasks change rarely; a short cache keeps the brief cheap to render.
  const refs = new Map<string, { at: number; value: { status: string; title: string } | null }>();
  async function refCache(id: string) {
    const hit = refs.get(id);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;
    const value = await pc.issue(id).then(
      (i) => ({ status: i.status, title: i.title }),
      (err) => (err instanceof PaperclipError && err.status === 404 ? null : Promise.reject(err)),
    );
    refs.set(id, { at: Date.now(), value });
    return value;
  }

  async function handleInternal(req: IncomingMessage, res: ServerResponse, url: URL) {
    const route = internal.find((r) => r.method === req.method && r.path.test(url.pathname));
    if (!route) throw new HttpError(404, "not found");
    const body = await readJson(req, route.maxBody);
    send(res, 200, JSON.stringify(await route.handle(url.pathname.match(route.path)!, body, url, req)), "application/json");
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname;
    const p = pairing.find((r) => r.method === req.method && r.path.test(path));
    if (p) {
      if (p.localOnly && mode !== "local") throw new HttpError(403, "only from the laptop");
      const body = req.method === "GET" || req.method === "DELETE" ? undefined : await readJson(req);
      return send(res, 200, JSON.stringify(await p.handle(path.match(p.path)!, body, req, res)), "application/json");
    }
    if (mode === "lan" && !store.checkSession(sessionToken(req))) throw new HttpError(401, "pair");
    const file = req.method === "GET" ? /^\/api\/issues\/([^/]+)\/files\/([0-9a-f-]{36})$/.exec(path) : null;
    if (file) return download(res, decodeURIComponent(file[1]!), file[2]!);
    const route = routes.find((r) => r.method === req.method && r.path.test(path));
    if (!route) throw new HttpError(404, "not found");
    const body = req.method === "GET" ? undefined : await readJson(req, route.maxBody);
    const result = await route.handle(path.match(route.path)!, body, url, req);
    send(res, 200, JSON.stringify(result), "application/json");
  }

  /**
   * Reconnect an expired Google account (D-36): /google/connect sends the browser to Google's consent
   * screen, Google sends it back to /google/callback, and google-workspace-mcp stores the new token.
   * Only on the laptop's loopback address: Google returns a Desktop-app sign-in only there.
   */
  async function handleGoogle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const port = loopbackPort(req.headers.host);
    if (!opts.google) throw new HttpError(404, "Google sign-in isn't set up on the board (no google_auth_token)");
    if (mode !== "local" || !port) throw new HttpError(403, "reconnect Google from the board on your computer (http://127.0.0.1:3120)");
    const host = String(req.headers.host).toLowerCase();
    try {
      if (url.pathname === "/google/connect") {
        const account = url.searchParams.get("account") ?? "";
        const { url: consent } = await opts.google.start(account, `http://${host}/google/callback`);
        log.info({ account }, "Google reconnect started");
        res.writeHead(302, { ...SECURITY_HEADERS, location: consent, "cache-control": "no-store" }).end();
        return;
      }
      if (url.pathname === "/google/callback") {
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code");
        if (!code) throw new GoogleAuthFailed(`Google didn't grant access (${url.searchParams.get("error") ?? "no code"})`);
        const { email } = await opts.google.finish(state, code);
        log.info({ account: email }, "Google account reconnected");
        res.writeHead(302, { ...SECURITY_HEADERS, location: "/", "cache-control": "no-store" }).end();
        return;
      }
    } catch (err) {
      if (!(err instanceof GoogleAuthFailed)) throw err;
      log.warn({ err: err.message }, "Google reconnect failed");
      return send(res, 400, page(`Couldn't reconnect Google: ${err.message}`), "text/html; charset=utf-8");
    }
    throw new HttpError(404, "not found");
  }

  /**
   * Sign in to Glean (D-38), Grafana, ClickHouse (D-57), Cloudflare (D-64) or Jira (D-69, each sign-in adds an Atlassian
   * account): /<service>/connect sends the browser to
   * the service's sign-in, which sends it back to the callback, and the proxy keeps the token. On the
   * laptop's loopback address only, like Google's Reconnect: the sign-in client is registered for that
   * redirect. Glean's callback is plain /callback because the organization's Glean only permits
   * loopback redirects of that shape; the others are /<service>/callback.
   */
  const SIGN_INS = {
    glean: { name: "Glean", secret: "glean_auth_token", connect: "/glean/connect", callback: "/callback" },
    grafana: { name: "Grafana", secret: "grafana_auth_token", connect: "/grafana/connect", callback: "/grafana/callback" },
    clickhouse: { name: "ClickHouse", secret: "clickhouse_auth_token", connect: "/clickhouse/connect", callback: "/clickhouse/callback" },
    cloudflare: { name: "Cloudflare", secret: "cloudflare_auth_token", connect: "/cloudflare/connect", callback: "/cloudflare/callback" },
    jira: { name: "Jira", secret: "jira_auth_token", connect: "/jira/connect", callback: "/jira/callback" },
    primer: { name: "Primer", secret: "primer_auth_token", connect: "/primer/connect", callback: "/primer/callback" },
  } as const;
  const signInFor = (path: string) => (Object.keys(SIGN_INS) as (keyof typeof SIGN_INS)[]).find((k) => SIGN_INS[k].connect === path || SIGN_INS[k].callback === path);

  async function handleSignIn(req: IncomingMessage, res: ServerResponse, url: URL, key: keyof typeof SIGN_INS) {
    const { name, secret, connect, callback } = SIGN_INS[key];
    const auth = opts[key];
    const port = loopbackPort(req.headers.host);
    if (!auth) throw new HttpError(404, `${name} sign-in isn't set up on the board (no ${secret})`);
    if (mode !== "local" || !port) throw new HttpError(403, `sign in to ${name} from the board on your computer (http://127.0.0.1:3120)`);
    const host = String(req.headers.host).toLowerCase();
    try {
      if (url.pathname === connect) {
        const { url: signIn } = await auth.start(`http://${host}${callback}`);
        log.info(`${name} sign-in started`);
        res.writeHead(302, { ...SECURITY_HEADERS, location: signIn, "cache-control": "no-store" }).end();
        return;
      }
      if (url.pathname === callback) {
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code");
        if (!code) throw new McpAuthFailed(`${name} didn't grant access (${url.searchParams.get("error") ?? "no code"})`);
        await auth.finish(state, code);
        log.info(`${name} connected`);
        res.writeHead(302, { ...SECURITY_HEADERS, location: "/", "cache-control": "no-store" }).end();
        return;
      }
    } catch (err) {
      if (!(err instanceof McpAuthFailed)) throw err;
      log.warn({ err: err.message }, `${name} sign-in failed`);
      return send(res, 400, page(`Couldn't connect ${name}: ${err.message}`), "text/html; charset=utf-8");
    }
    throw new HttpError(404, "not found");
  }

  async function serveStatic(res: ServerResponse, path: string) {
    const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
    let file = join(opts.staticDir, rel);
    if (!file.startsWith(opts.staticDir)) throw new HttpError(404, "not found");
    const isFile = await stat(file).then((s) => s.isFile()).catch(() => false);
    if (!isFile) file = join(opts.staticDir, "index.html"); // client-side routes
    const data = await readFile(file).catch(() => undefined);
    if (!data) throw new HttpError(404, "not found");
    const immutable = rel.startsWith("/assets/");
    send(res, 200, data, TYPES[extname(file)] ?? "application/octet-stream", immutable ? "public, max-age=31536000, immutable" : "no-cache");
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://board");
    if (url.pathname === "/healthz") return send(res, 200, "ok", "text/plain");
    // The LAN listener serves nothing, not even the page, outside the home network.
    if (mode === "lan" && !inNetworks(req.socket.remoteAddress, opts.lan?.clients ?? [])) {
      log.warn({ client: req.socket.remoteAddress, path: url.pathname }, "LAN request from outside the allowed networks");
      return send(res, 403, "forbidden", "text/plain");
    }
    if (mode === "internal") {
      try {
        if (!opts.internalToken || !bearerMatches(req.headers.authorization, opts.internalToken)) throw new HttpError(401, "unauthorized");
        if (!String(req.headers.host ?? "") || !opts.allowedHosts.includes(String(req.headers.host).toLowerCase())) throw new HttpError(403, "unknown host");
        await handleInternal(req, res, url);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : err instanceof BadRequest ? 400 : err instanceof PaperclipError ? (err.status === 404 ? 404 : 502) : 500;
        if (status >= 500 || status === 401) log[status === 401 ? "warn" : "error"]({ err: String((err as Error).message ?? err).slice(0, 500), path: url.pathname }, "internal request failed");
        if (!res.headersSent) send(res, status, JSON.stringify({ error: (err as Error).message ?? "error" }), "application/json");
      }
      return;
    }
    const rejected = checkRequest(req, opts.allowedHosts);
    if (rejected) {
      log.warn({ method: req.method, path: url.pathname, reason: rejected }, "request rejected");
      return send(res, 403, JSON.stringify({ error: rejected }), "application/json");
    }
    try {
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
      else if (url.pathname.startsWith("/google/") && req.method === "GET") await handleGoogle(req, res, url);
      else if (signInFor(url.pathname) && req.method === "GET") await handleSignIn(req, res, url, signInFor(url.pathname)!);
      else if (req.method === "GET" || req.method === "HEAD") await serveStatic(res, url.pathname);
      else throw new HttpError(405, "method not allowed");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof BadRequest ? 400 : err instanceof PaperclipError ? (err.status === 404 ? 404 : 502) : 500;
      if (status >= 500) log.error({ err: String((err as Error).message ?? err).slice(0, 500), path: url.pathname }, "request failed");
      if (!res.headersSent) send(res, status, JSON.stringify({ error: (err as Error).message ?? "error" }), "application/json");
    }
  });
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(/^Bearer (.+)$/.exec(String(header ?? ""))?.[1] ?? "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequest(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

async function readJson(req: IncomingMessage, max = 256_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, "too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequest("invalid JSON");
  }
}

/** A bare page for the sign-in outcome (the CSP allows no inline style or script). */
function page(text: string): string {
  const esc = text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pennyworth</title><p>${esc}</p><p><a href="/">Back to the board</a></p>`;
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, cache = "no-store") {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, "cache-control": cache });
  res.end(body);
}

/** The runner's latest job result per task (D-45: a failed run shows on the agent's portrait). */
export function latestJobs(report: { recent: { identifier: string; status?: string }[]; latest?: { identifier: string; status: string }[] } | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const j of [...(report?.recent ?? []), ...(report?.latest ?? [])]) if (j.status && !out.has(j.identifier)) out.set(j.identifier, j.status);
  return out;
}
