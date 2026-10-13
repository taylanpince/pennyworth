import type { Logger } from "pino";

export interface GoogleAccountStatus {
  email: string;
  primary: boolean;
  state: "unknown" | "ok" | "expired" | "error";
  since: string;
  detail?: string;
}

/**
 * Google sign-in state from google-workspace-mcp, and re-consent through it (D-36). The board holds
 * only the auth token, which reads sign-in state and starts or finishes a sign-in; it never sees a
 * Google token.
 */
export class GoogleAuth {
  private cached: { at: number; accounts: GoogleAccountStatus[]; error?: string } | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly log?: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new GoogleAuthFailed(data.error ?? `google-workspace-mcp answered ${res.status}`);
    return data;
  }

  /** Sign-in state per account, at most a minute old. Undefined when the sidecar can't be asked. */
  async status(maxAgeMs = 60_000): Promise<{ accounts: GoogleAccountStatus[]; error?: string } | undefined> {
    if (!this.cached || Date.now() - this.cached.at >= maxAgeMs) {
      try {
        const s = await this.call<{ accounts: GoogleAccountStatus[]; error?: string }>("GET", "/auth/status");
        this.cached = { at: Date.now(), accounts: s.accounts ?? [], ...(s.error ? { error: s.error } : {}) };
      } catch (err) {
        this.log?.warn({ err: String((err as Error).message).slice(0, 300) }, "Google sign-in state unavailable");
        this.cached = undefined;
      }
    }
    if (!this.cached) return undefined;
    const { at: _at, ...status } = this.cached;
    return status;
  }

  start(account: string, redirectUri: string) {
    return this.call<{ url: string }>("POST", "/auth/start", { account, redirect_uri: redirectUri });
  }

  async finish(state: string, code: string) {
    const r = await this.call<{ email: string }>("POST", "/auth/finish", { state, code });
    this.cached = undefined;
    return r;
  }
}

export class GoogleAuthFailed extends Error {}

/** Re-consent needs a loopback address: Google sends a Desktop-app sign-in back only to one. */
export function loopbackPort(host: string | undefined): number | undefined {
  const m = /^(?:localhost|127\.0\.0\.1):(\d{1,5})$/.exec(String(host ?? "").toLowerCase());
  return m ? Number(m[1]) : undefined;
}
