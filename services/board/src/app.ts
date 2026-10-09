import { timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { RecurringSchema, RunStateSchema, ScheduleSchema, changeRecurring, claimDue, recurringView, scheduleMove } from "./automation.js";
import { BadRequest, CreateSchema, UpdateSchema, assignees, buildBoard, commentView, displayText, executorOf, paperclipUpdate, replyTarget, toCard, type Assignee } from "./board.js";
import { inNetworks } from "./config.js";
import { Paperclip, PaperclipError, type Issue } from "./paperclip.js";
import { addDays, nextWorkday, type Weekday } from "./recurrence.js";
import { BUCKETS, isBucket, localDate, type Store } from "./store.js";

export interface AppOptions {
  paperclip: Paperclip;
  store: Store;
  log: Logger;
  allowedHosts: string[];
  staticDir: string;
  timezone: string;
  /** The days Tomorrow rolls into Today (D-28); Monday to Friday when not given. */
  workdays?: Weekday[];
  /**
   * "local": the loopback listener, trusted as the user. "lan": the home-network listener (D-23):
   * only clients from `lan.clients`, and the API only for paired devices (session cookie).
   * "internal": the tasks bridge and the runner (D-25), with a bearer token, /internal/ routes only.
   */
  mode?: "local" | "lan" | "internal";
  lan?: { clients: string[]; url: string };
  internalToken?: string;
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

  async function issueView(ref: string) {
    const { ctx, issue, assigned } = await ownIssue(ref);
    const comments = await pc.comments(issue.id);
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
      comments: comments.map((c) => commentView(c, ctx.me, ctx.agents)),
    };
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

  // The tasks bridge (Assistant tools) and the runner (recurring runs), with the internal token (D-25).
  const internal: typeof routes = [
    { method: "POST", path: /^\/internal\/issues\/([^/]+)\/schedule$/, handle: async (m, body) => schedule(decodeURIComponent(m[1]!), body) },
    { method: "POST", path: /^\/internal\/issues\/([^/]+)\/recurring$/, handle: async (m, body) => recurringChange(decodeURIComponent(m[1]!), body) },
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

  const routes: { method: string; path: RegExp; handle: (m: RegExpMatchArray, body: unknown, url: URL) => Promise<unknown> }[] = [
    {
      method: "GET",
      path: /^\/api\/board$/,
      handle: async () => {
        const ctx = await context();
        const since = new Date(Date.now() - RECENT_MS).toISOString();
        const [open, closed] = await Promise.all([pc.openIssues().then((l) => mine(l, ctx)), pc.closedSince(since).then((l) => mine(l, ctx))]);
        store.placeNew(open.map((i) => ({ id: i.id, createdAt: i.createdAt, status: i.status })));
        const recurring = new Map([...store.allRecurring()].map(([id, r]) => [id, { summary: recurringView(r, opts.timezone).summary, nextRun: r.nextRun, paused: r.paused }]));
        const board = buildBoard({ open, closed, placements: store.placements(), seen: store.allSeen(), schedules: store.schedules(), recurring, installedAt: store.meta("installed_at")!, assignees: ctx.assignees });
        // Lists truncate long descriptions; the brief is read in full.
        const brief = open.find((i) => i.id === board.brief?.id);
        if (board.brief && brief?.descriptionTruncated) board.brief.description = displayText((await pc.issue(brief.id)).description);
        // When Tomorrow next rolls into Today: the next calendar day, except before days off.
        const today = localDate(opts.timezone);
        const rollsOn = nextWorkday(today, opts.workdays ?? WORKWEEK);
        return { ...board, assignees: ctx.assignees, labels: ctx.labels, prefix: ctx.prefix, timezone: opts.timezone, rollsOn, rollsTomorrow: rollsOn === addDays(today, 1), buckets: board.buckets };
      },
    },
    { method: "GET", path: /^\/api\/issues\/([^/]+)$/, handle: async (m) => issueView(decodeURIComponent(m[1]!)) },
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
        return issueView(issue.id);
      },
    },
    {
      method: "POST",
      path: /^\/api\/issues\/([^/]+)\/comments$/,
      handle: async (m, body) => {
        const { issue, assigned } = await ownIssue(decodeURIComponent(m[1]!));
        if (!assigned) throw new HttpError(403, "this task isn't yours or an assistant's");
        const { body: text } = parse(z.object({ body: z.string().trim().min(1).max(30_000) }).strict(), body);
        // Hidden markers are machine-only: the runner ignores comments that carry its marker.
        await pc.addComment(issue.id, displayText(text));
        log.info({ issue: issue.identifier }, "comment added");
        return issueView(issue.id);
      },
    },
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
      path: /^\/api\/models\/([0-9a-f-]{36})$/,
      handle: async (m) => {
        const ctx = await context();
        const a = ctx.assignees.find((x) => x.key === m[1] && x.kind === "engineer");
        if (!a?.adapterType) throw new HttpError(404, "not an Engineer");
        let models = (await pc.models(a.adapterType).catch(() => [])).map((x) => x.id);
        if (a.engine === "openrouter") models = models.filter((x) => x.startsWith("openrouter/"));
        if (a.defaultModel && !models.includes(a.defaultModel)) models.unshift(a.defaultModel);
        return { default: a.defaultModel ?? null, models, efforts: a.efforts ?? [] };
      },
    },
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
    const body = await readJson(req);
    send(res, 200, JSON.stringify(await route.handle(url.pathname.match(route.path)!, body, url)), "application/json");
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
    const route = routes.find((r) => r.method === req.method && r.path.test(path));
    if (!route) throw new HttpError(404, "not found");
    const body = req.method === "GET" ? undefined : await readJson(req);
    const result = await route.handle(path.match(route.path)!, body, url);
    send(res, 200, JSON.stringify(result), "application/json");
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256_000) throw new HttpError(413, "too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequest("invalid JSON");
  }
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, cache = "no-store") {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, "cache-control": cache });
  res.end(body);
}
