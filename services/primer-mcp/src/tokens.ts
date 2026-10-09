import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Written by src/auth.ts: the token pair plus the dynamically registered client it belongs to. */
export interface StoredToken {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  scope?: string;
  client_id: string;
  token_endpoint: string;
  resource?: string;
}

export class PrimerAuthError extends Error {}

/** Normalize a standard OAuth 2 token response. */
export function parseTokenResponse(json: Record<string, unknown>, now = Date.now()): Pick<StoredToken, "access_token" | "refresh_token" | "expires_at" | "scope"> {
  if (typeof json.error === "string") throw new PrimerAuthError(`Primer OAuth error: ${json.error}`);
  const access = json.access_token;
  if (typeof access !== "string" || !access) throw new PrimerAuthError("Primer OAuth response had no access token");
  const expiresIn = Number(json.expires_in);
  return {
    access_token: access,
    refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
    scope: typeof json.scope === "string" ? json.scope : undefined,
  };
}

/**
 * Holds the user token and refreshes it. The newest token pair is written back atomically,
 * because Primer rotates refresh tokens on every use and revokes the whole family when an
 * old one is reused. One proxy process is the only refresher.
 */
export class TokenStore {
  private token?: StoredToken;
  private refreshing?: Promise<StoredToken>;

  constructor(
    private readonly path: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  available(): boolean {
    return existsSync(this.path);
  }

  private load(): StoredToken {
    if (!this.token) {
      if (!existsSync(this.path)) throw new PrimerAuthError("Primer is not connected yet (run scripts/primer-auth.sh)");
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
    if (!t.refresh_token) throw new PrimerAuthError("Primer token expired and has no refresh token (run scripts/primer-auth.sh)");
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.client_id });
    if (t.resource) body.set("resource", t.resource);
    const res = await this.fetchImpl(t.token_endpoint, { method: "POST", body, signal: AbortSignal.timeout(15_000) });
    const next = parseTokenResponse((await res.json()) as Record<string, unknown>);
    this.save({ ...t, ...next, refresh_token: next.refresh_token ?? t.refresh_token });
    return this.token!;
  }
}
