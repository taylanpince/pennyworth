import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Written by a sign-in (src/signin.ts): the token pair plus the registered client it belongs to. */
export interface StoredToken {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  scope?: string;
  client_id: string;
  client_secret?: string;
  token_endpoint: string;
  resource?: string;
}

/** Sign-in state for the board's banner and the healthcheck. */
export interface AuthStatus {
  state: "missing" | "ok" | "expired" | "unknown";
  since: string;
  detail?: string;
}

export class GrafanaAuthError extends Error {}

/** Normalize a standard OAuth 2 token response. */
export function parseTokenResponse(json: Record<string, unknown>, now = Date.now()): Pick<StoredToken, "access_token" | "refresh_token" | "expires_at" | "scope"> {
  if (typeof json.error === "string") throw new GrafanaAuthError(`Grafana OAuth error: ${json.error}`);
  const access = json.access_token;
  if (typeof access !== "string" || !access) throw new GrafanaAuthError("Grafana OAuth response had no access token");
  const expiresIn = Number(json.expires_in);
  return {
    access_token: access,
    refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
    scope: typeof json.scope === "string" ? json.scope : undefined,
  };
}

/**
 * Holds the user token and refreshes it. The newest pair is written back atomically, in case Grafana
 * rotates refresh tokens. One proxy process is the only refresher. A refresh Grafana refuses marks the
 * sign-in expired, which the board shows with a Reconnect button.
 */
export class TokenStore {
  private token?: StoredToken;
  private refreshing?: Promise<StoredToken>;
  private status_: AuthStatus = { state: "unknown", since: new Date().toISOString() };

  constructor(
    private readonly path: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  available(): boolean {
    return existsSync(this.path);
  }

  status(): AuthStatus {
    if (!this.available()) return { state: "missing", since: this.status_.since };
    return this.status_;
  }

  /** Record what the last use of the token showed. */
  mark(state: "ok" | "expired", detail?: string): void {
    if (this.status_.state === state && this.status_.detail === detail) return;
    this.status_ = { state, since: new Date().toISOString(), ...(detail ? { detail } : {}) };
  }

  private load(): StoredToken {
    if (!this.token) {
      if (!existsSync(this.path)) throw new GrafanaAuthError("Grafana is not connected yet (Connect on the board)");
      this.token = JSON.parse(readFileSync(this.path, "utf8")) as StoredToken;
    }
    return this.token;
  }

  /** Store a token pair from a new sign-in. */
  replace(t: StoredToken): void {
    this.save(t);
    this.mark("ok");
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
    if (!t.refresh_token) {
      this.mark("expired", "the sign-in has no refresh token");
      throw new GrafanaAuthError("Grafana token expired and has no refresh token (Reconnect on the board)");
    }
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.client_id });
    if (t.client_secret) body.set("client_secret", t.client_secret);
    if (t.resource) body.set("resource", t.resource);
    const res = await this.fetchImpl(t.token_endpoint, { method: "POST", body, signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    let next;
    try {
      if (!res.ok && typeof json.error !== "string") throw new GrafanaAuthError(`Grafana token endpoint answered ${res.status}`);
      next = parseTokenResponse(json);
    } catch (err) {
      // A refusal (invalid_grant and the like) needs the user; a 5xx is Grafana's problem and may pass.
      if (res.status < 500) this.mark("expired", String((err as Error).message));
      throw err;
    }
    this.save({ ...t, ...next, refresh_token: next.refresh_token ?? t.refresh_token });
    return this.token!;
  }
}
