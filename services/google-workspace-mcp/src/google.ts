import { readFileSync } from "node:fs";

/** Read-only scopes requested at consent time. Nothing here can modify Google data. */
export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
];

export interface StoredCredentials {
  client_id: string;
  client_secret?: string;
  refresh_token: string;
  scopes?: string[];
}

export class GoogleAuthError extends Error {}

/**
 * Whether an account's sign-in still works, from its last token refresh. "expired": Google refused
 * the refresh token (invalid_grant: past the OAuth app's 7-day Testing limit, or revoked), so only
 * re-consent helps. "error": Google couldn't be reached or answered oddly; it may pass on its own.
 */
export interface AuthStatus {
  state: "unknown" | "ok" | "expired" | "error";
  /** When the account entered this state. */
  since: string;
  checkedAt?: string;
  detail?: string;
}

/** Token endpoint errors that mean the refresh token itself is dead. */
const DEAD_GRANT = new Set(["invalid_grant", "unauthorized_client", "invalid_client"]);

export function loadCredentials(path: string): StoredCredentials {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredCredentials>;
  if (!raw.client_id || !raw.refresh_token) throw new GoogleAuthError(`credentials file ${path} is missing client_id or refresh_token`);
  return raw as StoredCredentials;
}

/** Minimal Google REST client with refresh-token auth. GET requests only. */
export class GoogleClient {
  private accessToken?: { value: string; expiresAt: number };
  private auth: AuthStatus = { state: "unknown", since: new Date().toISOString() };

  constructor(
    private readonly creds: StoredCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt - 60_000 > Date.now()) return this.accessToken.value;
    const body = new URLSearchParams({ client_id: this.creds.client_id, refresh_token: this.creds.refresh_token, grant_type: "refresh_token" });
    if (this.creds.client_secret) body.set("client_secret", this.creds.client_secret);
    let res: Response;
    let json: { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    try {
      res = await this.fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", body, signal: AbortSignal.timeout(15_000) });
      json = (await res.json()) as typeof json;
    } catch (err) {
      this.record("error", `token refresh failed: ${(err as Error).message}`);
      throw err;
    }
    if (!res.ok || !json.access_token) {
      const detail = `token refresh failed: ${json.error ?? res.status} ${json.error_description ?? ""}`.trim();
      this.record(json.error && DEAD_GRANT.has(json.error) ? "expired" : "error", detail);
      throw new GoogleAuthError(detail);
    }
    this.record("ok");
    this.accessToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.accessToken.value;
  }

  private record(state: AuthStatus["state"], detail?: string) {
    const now = new Date().toISOString();
    this.auth = { state, since: state === this.auth.state ? this.auth.since : now, checkedAt: now, ...(detail ? { detail: detail.slice(0, 300) } : {}) };
  }

  authStatus(): AuthStatus {
    return { ...this.auth };
  }

  /** Refreshes the token now rather than from cache, so a dead refresh token shows up before a tool needs it. */
  async checkAuth(): Promise<AuthStatus> {
    this.accessToken = undefined;
    await this.token().catch(() => {});
    return this.authStatus();
  }

  async get<T>(url: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
    const res = await this.fetchImpl(u, { headers: { authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      throw new GoogleAuthError(`Google API ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  async getText(url: string, params: Record<string, string> = {}, maxBytes = 2_000_000): Promise<{ text: string; truncated: boolean }> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const res = await this.fetchImpl(u, { headers: { authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: buf.length > maxBytes };
  }
}
