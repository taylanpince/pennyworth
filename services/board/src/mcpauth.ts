import type { Logger } from "pino";

export interface McpAuthStatus {
  state: "missing" | "ok" | "expired" | "unknown";
  /** Whether the service's server is set (GLEAN_MCP_URL, GRAFANA_URL): without it there's no banner. */
  configured: boolean;
  since: string;
  detail?: string;
}

/**
 * Sign-in state from an MCP proxy that signs in with OAuth (glean-mcp, D-38; grafana-mcp), and
 * signing in through it, like Google's Reconnect (D-36): the board sends the browser to the
 * service's sign-in, which sends it back to the board's callback, and the proxy exchanges the code
 * and keeps the token. The board holds only the proxy's auth token; it never sees a service token.
 */
export class McpAuth {
  private cached: { at: number; status: McpAuthStatus } | undefined;

  constructor(
    /** The service's name in logs and messages ("Glean"). */
    private readonly name: string,
    /** The proxy's name in errors ("glean-mcp"). */
    private readonly service: string,
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
    if (!res.ok) throw new McpAuthFailed(data.error ?? `${this.service} answered ${res.status}`);
    return data;
  }

  /** Sign-in state, at most a minute old. Undefined when the proxy can't be asked. */
  async status(maxAgeMs = 60_000): Promise<McpAuthStatus | undefined> {
    if (!this.cached || Date.now() - this.cached.at >= maxAgeMs) {
      try {
        this.cached = { at: Date.now(), status: await this.call<McpAuthStatus>("GET", "/auth/status") };
      } catch (err) {
        this.log?.warn({ err: String((err as Error).message).slice(0, 300) }, `${this.name} sign-in state unavailable`);
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

export class McpAuthFailed extends Error {}

/** Glean (D-38). */
export class GleanAuth extends McpAuth {
  constructor(baseUrl: string, token: string, log?: Logger, fetchImpl?: typeof fetch) {
    super("Glean", "glean-mcp", baseUrl, token, log, fetchImpl);
  }
}

/** Grafana Cloud, for the runner's Engineer jobs (read and query scopes only). */
export class GrafanaAuth extends McpAuth {
  constructor(baseUrl: string, token: string, log?: Logger, fetchImpl?: typeof fetch) {
    super("Grafana", "grafana-mcp", baseUrl, token, log, fetchImpl);
  }
}
