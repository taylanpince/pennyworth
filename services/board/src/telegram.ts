import type { Logger } from "pino";

export interface TelegramStatus {
  state: "missing" | "ok" | "ended" | "error";
  /** Whether telegram/api.json exists: without it Telegram is simply not set up. */
  configured: boolean;
  since: string;
  detail?: string;
  account?: { name: string; username: string | null };
}

export type TelegramStep = { step: "code" | "password"; login_id: string; via_app?: boolean } | { step: "done"; account: { name: string; username: string | null } };

/**
 * Telegram sign-in state from telegram-mcp, and signing in through it (D-37): phone number, the code
 * Telegram sends, then the 2FA password if there is one. The board holds only the auth token, which
 * reads sign-in state and drives a sign-in; it never sees the session or reads messages.
 */
export class TelegramAuth {
  private cached: { at: number; status: TelegramStatus } | undefined;

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
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new TelegramAuthFailed(data.error ?? `telegram-mcp answered ${res.status}`);
    return data;
  }

  /** Sign-in state, at most a minute old. Undefined when telegram-mcp can't be asked. */
  async status(maxAgeMs = 60_000): Promise<TelegramStatus | undefined> {
    if (!this.cached || Date.now() - this.cached.at >= maxAgeMs) {
      try {
        this.cached = { at: Date.now(), status: await this.call<TelegramStatus>("GET", "/auth/status") };
      } catch (err) {
        this.log?.warn({ err: String((err as Error).message).slice(0, 300) }, "Telegram sign-in state unavailable");
        this.cached = undefined;
      }
    }
    return this.cached?.status;
  }

  private async step(path: string, body: unknown): Promise<TelegramStep> {
    const r = await this.call<TelegramStep>("POST", path, body);
    if (r.step === "done") this.cached = undefined;
    return r;
  }

  start(phone: string) {
    return this.step("/auth/start", { phone });
  }

  code(login_id: string, code: string) {
    return this.step("/auth/code", { login_id, code });
  }

  password(login_id: string, password: string) {
    return this.step("/auth/password", { login_id, password });
  }
}

export class TelegramAuthFailed extends Error {}
