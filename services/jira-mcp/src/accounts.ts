import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { matchesSite, type Site, siteOf, isWrite } from "./policy.js";
import { AtlassianAuthError, type AuthStatus, type StoredToken, TokenStore } from "./tokens.js";

/** Who a sign-in is and which sites it reaches, kept next to its token (never the token itself). */
export interface AccountInfo {
  id: string;
  accountId?: string;
  email?: string;
  name?: string;
  sites: Site[];
  addedAt: string;
}

export interface CallResult {
  content?: { type?: string; text?: string }[];
  isError?: boolean;
  [k: string]: unknown;
}

/** An open connection to the Rovo MCP server as one account. */
export interface Upstream {
  tools: Tool[];
  call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<CallResult>;
  close(): Promise<void>;
}

export type Connector = (token: string) => Promise<Upstream>;

/** Tools about the sign-ins themselves: asked of every account, answers joined. */
const EVERY_ACCOUNT = new Set(["atlassianUserInfo", "getAccessibleAtlassianResources"]);

export class RouteError extends Error {}

const isAuthFailure = (err: unknown) => /401|unauthori[sz]ed|unauthenticated|invalid_token|not_authenticated/i.test(String(err));

/** The JSON in a tool's text answer, if there is any. */
function jsonOf(r: CallResult): unknown {
  const text = (r.content ?? []).map((c) => c.text ?? "").join("");
  try {
    return JSON.parse(text);
  } catch {
    const m = /[[{][\s\S]*[\]}]/.exec(text);
    try {
      return m ? JSON.parse(m[0]) : undefined;
    } catch {
      return undefined;
    }
  }
}

export function parseSites(r: CallResult): Site[] {
  const j = jsonOf(r) as unknown;
  const list = Array.isArray(j) ? j : Array.isArray((j as { resources?: unknown })?.resources) ? (j as { resources: unknown[] }).resources : [];
  return list
    .filter((s): s is { id: string; url: string; name?: string } => typeof (s as Site)?.id === "string" && typeof (s as Site)?.url === "string")
    .map((s) => ({ id: s.id, url: s.url, ...(typeof s.name === "string" ? { name: s.name } : {}) }));
}

export function parseUser(r: CallResult): Pick<AccountInfo, "accountId" | "email" | "name"> {
  const j = (jsonOf(r) ?? {}) as Record<string, unknown>;
  const str = (...keys: string[]) => keys.map((k) => j[k]).find((v): v is string => typeof v === "string" && v.length > 0 && v.length < 300);
  const accountId = str("account_id", "accountId");
  const email = str("email");
  const name = str("name", "displayName", "nickname");
  return { ...(accountId ? { accountId } : {}), ...(email ? { email } : {}), ...(name ? { name } : {}) };
}

/** "you@x.com · polygon.atlassian.net, coinme.atlassian.net", for Settings and for joined answers. */
export function label(info: AccountInfo): string {
  const who = info.email ?? info.name ?? `Atlassian account ${info.id}`;
  const sites = info.sites.map((s) => s.url.replace(/^https?:\/\//, "").replace(/\/$/, ""));
  return sites.length ? `${who} · ${sites.join(", ")}` : who;
}

class Account {
  upstream?: { conn: Upstream; at: number };
  constructor(
    public info: AccountInfo,
    public readonly tokens: TokenStore,
  ) {}
}

/**
 * Every Atlassian account signed in (D-69): the user's Polygon one, a client's own Jira (Coinme's), as
 * many as they add. Each has its own token pair in /state/accounts/<id>.json and its own connection to
 * the Rovo MCP server. A call goes to the account that reaches the site it names (cloudId, or the cloud
 * id in an ARI); with one account, everything goes there.
 */
export class Accounts {
  private readonly accounts = new Map<string, Account>();

  constructor(
    private readonly dir: string,
    private readonly connector: Connector,
    private readonly log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".info.json"))) {
      try {
        const info = JSON.parse(readFileSync(join(dir, f), "utf8")) as AccountInfo;
        if (/^[a-z0-9]{1,32}$/.test(info.id) && existsSync(this.tokenPath(info.id))) this.accounts.set(info.id, new Account(info, new TokenStore(this.tokenPath(info.id), fetchImpl)));
      } catch {
        this.log?.warn({ file: f }, "unreadable Atlassian account file skipped");
      }
    }
  }

  private tokenPath(id: string) {
    return join(this.dir, `${id}.json`);
  }

  private saveInfo(info: AccountInfo): void {
    const path = join(this.dir, `${info.id}.info.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }

  list(): AccountInfo[] {
    return [...this.accounts.values()].map((a) => a.info);
  }

  /** Each account's sign-in state, for Settings and the healthcheck. */
  statuses(): (AuthStatus & { id: string; label: string })[] {
    return [...this.accounts.values()].map((a) => ({ id: a.info.id, label: label(a.info), ...a.tokens.status() }));
  }

  private async connect(a: Account): Promise<Upstream> {
    const conn = await this.connector(await a.tokens.accessToken());
    a.upstream = { conn, at: Date.now() };
    a.tokens.mark("ok");
    // Sites come and go (an invitation accepted, access removed): keep the routing current.
    try {
      const sites = parseSites(await conn.call("getAccessibleAtlassianResources", {}, 20_000));
      if (sites.length && JSON.stringify(sites) !== JSON.stringify(a.info.sites)) {
        a.info = { ...a.info, sites };
        this.saveInfo(a.info);
      }
    } catch (err) {
      this.log?.warn({ account: a.info.id, err: String(err).slice(0, 200) }, "couldn't list the account's Atlassian sites");
    }
    return conn;
  }

  private async reset(a: Account, forceRefresh: boolean): Promise<Upstream> {
    const old = a.upstream;
    a.upstream = undefined;
    await old?.conn.close().catch(() => undefined);
    if (forceRefresh) await a.tokens.refresh();
    return this.connect(a);
  }

  /** Run fn on the account's connection: reconnect every 30 minutes, and refresh once after an auth failure. */
  async with<T>(a: Account, fn: (u: Upstream) => Promise<T>): Promise<T> {
    try {
      const u = !a.upstream || Date.now() - a.upstream.at > 30 * 60_000 ? await this.reset(a, false) : a.upstream.conn;
      return await fn(u);
    } catch (err) {
      if (err instanceof AtlassianAuthError || !isAuthFailure(err)) throw err;
      this.log?.warn({ account: a.info.id }, "Atlassian rejected the token; refreshing and retrying once");
      try {
        return await fn(await this.reset(a, true));
      } catch (again) {
        if (isAuthFailure(again)) a.tokens.mark("expired", "Atlassian rejected a freshly refreshed token");
        throw again;
      }
    }
  }

  /** Connect every account whose state isn't known yet (after a restart), so Settings shows the truth. */
  async probe(): Promise<void> {
    await Promise.all([...this.accounts.values()].filter((a) => a.tokens.status().state === "unknown").map((a) => this.with(a, async () => undefined).catch(() => undefined)));
  }

  /** The Rovo server's tools, from the first account that answers (they're the same for every account). */
  async tools(): Promise<Tool[]> {
    let last: unknown = new AtlassianAuthError("no Atlassian account is connected (Connect in Settings)");
    for (const a of this.accounts.values()) {
      if (a.tokens.status().state === "expired") continue;
      try {
        return await this.with(a, async (u) => u.tools);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }

  /** The accounts a call goes to: the one reaching its site, every account, or a refusal saying why. */
  route(name: string, args: Record<string, unknown>): Account[] {
    const all = [...this.accounts.values()];
    if (!all.length) throw new AtlassianAuthError("no Atlassian account is connected (Connect in Settings)");
    if (EVERY_ACCOUNT.has(name)) return all;
    const ref = siteOf(args);
    if (ref) {
      const hit = all.find((a) => a.info.sites.some((s) => matchesSite(ref, s)));
      if (hit) return [hit];
      // A single sign-in whose sites aren't known yet: let Atlassian answer.
      if (all.length === 1 && !all[0]!.info.sites.length) return all;
      const known = all.flatMap((a) => a.info.sites.map((s) => s.url.replace(/^https?:\/\//, "")));
      throw new RouteError(`No connected Atlassian account reaches ${ref}. Connected sites: ${known.join(", ") || "none listed"}. The user can add the account in Settings.`);
    }
    if (all.length === 1) return all;
    if (isWrite(name)) throw new RouteError(`Several Atlassian sites are connected: pass cloudId (the site, e.g. ${all[0]!.info.sites[0]?.url.replace(/^https?:\/\//, "") ?? "your-site.atlassian.net"}) to say which.`);
    return all;
  }

  /** Call a tool as the right account, or every account with the answers joined under each account's name. */
  async call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<CallResult> {
    const targets = this.route(name, args);
    if (targets.length === 1) return this.with(targets[0]!, (u) => u.call(name, args, timeoutMs));
    const results = await Promise.all(
      targets.map((a) =>
        this.with(a, (u) => u.call(name, args, timeoutMs)).catch(
          (err): CallResult => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: err instanceof AtlassianAuthError || a.tokens.status().state === "expired" ? "atlassian_auth_unavailable" : "atlassian_error", detail: String((err as Error).message).slice(0, 300) }) }] }),
        ),
      ),
    );
    return {
      content: results.flatMap((r, i) => [{ type: "text", text: `Account: ${label(targets[i]!.info)}` }, ...(r.content ?? [])]),
      ...(results.every((r) => r.isError) ? { isError: true } : {}),
    };
  }

  /**
   * Keep a new sign-in: find out whose it is and which sites it reaches. The same person signing in
   * again for sites they already had replaces that account (a Reconnect); anything else is added.
   */
  async add(token: StoredToken): Promise<AccountInfo> {
    const conn = await this.connector(token.access_token);
    let user: ReturnType<typeof parseUser> = {};
    let sites: Site[] = [];
    try {
      user = parseUser(await conn.call("atlassianUserInfo", {}, 20_000));
      sites = parseSites(await conn.call("getAccessibleAtlassianResources", {}, 20_000));
    } finally {
      await conn.close().catch(() => undefined);
    }
    const same = [...this.accounts.values()].find(
      (a) => (user.accountId ? a.info.accountId === user.accountId : Boolean(user.email) && a.info.email === user.email) && (!sites.length || !a.info.sites.length || a.info.sites.some((s) => sites.some((n) => n.id === s.id))),
    );
    const id = same?.info.id ?? randomBytes(4).toString("hex");
    const info: AccountInfo = { id, ...user, sites, addedAt: same?.info.addedAt ?? new Date().toISOString() };
    const tokens = new TokenStore(this.tokenPath(id), this.fetchImpl);
    tokens.replace(token);
    this.saveInfo(info);
    await same?.upstream?.conn.close().catch(() => undefined);
    this.accounts.set(id, new Account(info, tokens));
    this.log?.info({ account: id, sites: sites.map((s) => s.url), replaced: Boolean(same) }, "Atlassian account signed in");
    return info;
  }

  /** Forget an account: its token and info files go, and its calls stop. */
  async remove(id: string): Promise<boolean> {
    const a = this.accounts.get(id);
    if (!a) return false;
    this.accounts.delete(id);
    await a.upstream?.conn.close().catch(() => undefined);
    rmSync(this.tokenPath(id), { force: true });
    rmSync(join(this.dir, `${id}.info.json`), { force: true });
    return true;
  }
}
