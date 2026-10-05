import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TOKEN_ENDPOINT = "https://slack.com/api/oauth.v2.user.access";
export const AUTHORIZE_ENDPOINT = "https://slack.com/oauth/v2_user/authorize";

/**
 * User-token scopes requested at consent: read and search only. Slack's MCP server
 * cannot post, react or edit with a token that lacks the write scopes.
 */
export const READ_SCOPES = [
  "search:read.public",
  "search:read.private",
  "search:read.im",
  "search:read.mpim",
  "search:read.users",
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "users:read",
];

const WRITE_SCOPE = /(:write|^chat:|^reactions:write|^files:write)/;

export interface StoredToken {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  scope?: string;
  user_id?: string;
  team_id?: string;
}

export class SlackAuthError extends Error {}

/** Normalize an oauth.v2.user.access response (token at top level or under authed_user). */
export function parseTokenResponse(json: Record<string, unknown>, now = Date.now()): StoredToken {
  if (json.ok === false) throw new SlackAuthError(`Slack OAuth error: ${String(json.error ?? "unknown")}`);
  const src = (json.authed_user as Record<string, unknown> | undefined)?.access_token ? (json.authed_user as Record<string, unknown>) : json;
  const access = src.access_token;
  if (typeof access !== "string" || !access) throw new SlackAuthError("Slack OAuth response had no access token");
  const expiresIn = Number(src.expires_in ?? json.expires_in);
  return {
    access_token: access,
    refresh_token: typeof src.refresh_token === "string" ? src.refresh_token : undefined,
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
    scope: typeof src.scope === "string" ? src.scope : undefined,
    user_id: typeof (src.id ?? json.user_id) === "string" ? String(src.id ?? json.user_id) : undefined,
    team_id: typeof (json.team as { id?: string } | undefined)?.id === "string" ? (json.team as { id: string }).id : undefined,
  };
}

/** Scopes in a granted token that would allow writing. Empty for a read-only token. */
export function writeScopes(scope: string | undefined): string[] {
  return (scope ?? "").split(/[ ,]+/).filter((s) => s && WRITE_SCOPE.test(s));
}

/**
 * Holds the user token and refreshes it with Slack's rotating refresh tokens. The
 * newest token pair is written back atomically, because a used refresh token stops working.
 */
export class TokenStore {
  private token?: StoredToken;
  private refreshing?: Promise<StoredToken>;

  constructor(
    private readonly path: string,
    private readonly clientId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  available(): boolean {
    return existsSync(this.path);
  }

  private load(): StoredToken {
    if (!this.token) {
      if (!existsSync(this.path)) throw new SlackAuthError("Slack is not connected yet (run scripts/slack-auth.sh)");
      this.token = JSON.parse(readFileSync(this.path, "utf8")) as StoredToken;
    }
    return this.token;
  }

  private save(t: StoredToken): void {
    const tmp = join(dirname(this.path), `.token.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    this.token = t;
  }

  async accessToken(): Promise<string> {
    const t = this.load();
    if (!t.expires_at || t.expires_at - 120_000 > Date.now()) return t.access_token;
    return (await this.refresh()).access_token;
  }

  /** Force a refresh (e.g. after a 401). Concurrent callers share one refresh. */
  async refresh(): Promise<StoredToken> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async doRefresh(): Promise<StoredToken> {
    const t = this.load();
    if (!t.refresh_token) throw new SlackAuthError("Slack token expired and has no refresh token (run scripts/slack-auth.sh)");
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: this.clientId });
    const res = await this.fetchImpl(TOKEN_ENDPOINT, { method: "POST", body, signal: AbortSignal.timeout(15_000) });
    const next = parseTokenResponse((await res.json()) as Record<string, unknown>);
    this.save({ ...t, ...next, refresh_token: next.refresh_token ?? t.refresh_token });
    return this.token!;
  }
}
