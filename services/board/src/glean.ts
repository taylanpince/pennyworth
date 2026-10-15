import type { Logger } from "pino";

export interface GleanStatus {
  state: "missing" | "ok" | "expired" | "unknown";
  /** Whether GLEAN_MCP_URL is set: without it Glean is simply not set up, and there's no banner. */
  configured: boolean;
  since: string;
  detail?: string;
}

/**
 * Glean sign-in state from glean-mcp, and signing in through it (D-38), like Google's Reconnect
 * (D-36): /glean/connect sends the browser to Glean's sign-in, Glean sends it back to
 * /glean/callback, and glean-mcp exchanges the code and keeps the token. The board holds only the
 * auth token; it never sees a Glean token.
 */
export class GleanAuth {
  private cached: { at: number; status: GleanStatus } | undefined;

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
    if (!res.ok) throw new GleanAuthFailed(data.error ?? `glean-mcp answered ${res.status}`);
    return data;
  }

  /** Sign-in state, at most a minute old. Undefined when glean-mcp can't be asked. */
  async status(maxAgeMs = 60_000): Promise<GleanStatus | undefined> {
    if (!this.cached || Date.now() - this.cached.at >= maxAgeMs) {
      try {
        this.cached = { at: Date.now(), status: await this.call<GleanStatus>("GET", "/auth/status") };
      } catch (err) {
        this.log?.warn({ err: String((err as Error).message).slice(0, 300) }, "Glean sign-in state unavailable");
        this.cached = undefined;
      }
    }
    return this.cached?.status;
  }

  start(redirectUri: string) {
    return this.call<{ url: string }>("POST", "/auth/start", { redirect_uri: redirectUri });
  }

  async finish(state: string, code: string): Promise<void> {
    await this.call<{ ok: true }>("POST", "/auth/finish", { state, code });
    this.cached = undefined;
  }
}

export class GleanAuthFailed extends Error {}
