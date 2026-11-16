import { z } from "zod";

/**
 * Sign-ins the runner makes on the laptop, driven from Settings (D-66). The runner runs each tool's
 * own browserless login (gcloud, aws sso, gh, codex, claude setup-token) and reports what to show:
 * a link, a one-time code, a prompt for something to paste. The board relays that to the page and
 * the user's answer back. What the user types reaches the runner once and is never kept or logged;
 * no credential ever comes back. In memory only: a board restart drops sessions in flight.
 */

export const SIGNIN_PROVIDERS = ["gcloud", "aws", "gh", "github", "codex", "paperclip-codex", "claude", "openrouter"] as const;
export type SignInProvider = (typeof SIGNIN_PROVIDERS)[number];

export type SignInStatus = "starting" | "waiting" | "done" | "failed" | "cancelled";

export interface SignInSession {
  id: string;
  provider: SignInProvider;
  status: SignInStatus;
  /** Where to approve the sign-in (an https link only). */
  url?: string;
  /** A one-time code to enter at that link. */
  code?: string;
  /** Something the user pastes back (a verification code, an API key). */
  prompt?: { label: string; secret: boolean };
  message?: string;
  startedAt: string;
  updatedAt: string;
}

export type RunnerCommand = { session: string; kind: "start"; provider: SignInProvider } | { session: string; kind: "input"; text: string } | { session: string; kind: "cancel" };

const Update = z
  .object({
    session: z.string().regex(/^[a-f0-9]{24}$/),
    status: z.enum(["starting", "waiting", "done", "failed", "cancelled"]),
    url: z
      .string()
      .url()
      .max(4096)
      .refine((u) => u.startsWith("https://"), "https links only")
      .optional(),
    code: z.string().regex(/^[A-Za-z0-9-]{4,20}$/).optional(),
    prompt: z.object({ label: z.string().min(1).max(200), secret: z.boolean() }).strict().optional(),
    message: z.string().max(400).optional(),
  })
  .strict();
/** `wait: false`: the runner only delivers updates (a link or code to show now) and takes any commands. */
export const RunnerPollSchema = z.object({ updates: z.array(Update).max(20), wait: z.boolean().optional() }).strict();

const FINISHED: SignInStatus[] = ["done", "failed", "cancelled"];

export class SignIns {
  private readonly sessions = new Map<SignInProvider, SignInSession>();
  private commands: RunnerCommand[] = [];
  private waiter?: () => void;
  private lastPoll = 0;

  constructor(
    private readonly newId: () => string,
    /** A session the runner never finishes is given up after this long (the tools' codes expire in 10–15 minutes). */
    private readonly ttlMs = 20 * 60_000,
  ) {}

  /** Whether the runner is listening: it holds a poll open, or made one in the last minute. */
  runnerOnline(now = Date.now()): boolean {
    return Boolean(this.waiter) || now - this.lastPoll < 60_000;
  }

  get(provider: SignInProvider, now = Date.now()): SignInSession | undefined {
    const s = this.sessions.get(provider);
    if (s && !FINISHED.includes(s.status) && now - Date.parse(s.startedAt) > this.ttlMs) {
      this.finish(s, "failed", "The sign-in took too long. Start again.");
      this.push({ session: s.id, kind: "cancel" });
    }
    return this.sessions.get(provider);
  }

  start(provider: SignInProvider, now = new Date()): SignInSession {
    const old = this.get(provider);
    if (old && !FINISHED.includes(old.status)) this.cancel(provider);
    const at = now.toISOString();
    const s: SignInSession = { id: this.newId(), provider, status: "starting", message: "Waiting for the runner on the laptop…", startedAt: at, updatedAt: at };
    this.sessions.set(provider, s);
    this.push({ session: s.id, kind: "start", provider });
    return s;
  }

  input(provider: SignInProvider, text: string): SignInSession {
    const s = this.get(provider);
    if (!s || s.status !== "waiting" || !s.prompt) throw new Error("This sign-in isn't waiting for anything. Start again.");
    this.push({ session: s.id, kind: "input", text });
    const { prompt: _asked, ...rest } = s;
    const next: SignInSession = { ...rest, message: "Checking…", updatedAt: new Date().toISOString() };
    this.sessions.set(provider, next);
    return next;
  }

  cancel(provider: SignInProvider): SignInSession | undefined {
    const s = this.sessions.get(provider);
    if (!s || FINISHED.includes(s.status)) return s;
    this.push({ session: s.id, kind: "cancel" });
    return this.finish(s, "cancelled", "Cancelled.");
  }

  /**
   * The runner's long poll: apply what it reports, then hand over the queued commands, waiting up
   * to `waitMs` for one. Commands go out once: input text is gone from the board after this.
   */
  async poll(updates: z.infer<typeof RunnerPollSchema>["updates"], waitMs = 25_000): Promise<RunnerCommand[]> {
    this.lastPoll = Date.now();
    for (const u of updates) {
      const s = [...this.sessions.values()].find((x) => x.id === u.session);
      if (!s || FINISHED.includes(s.status)) continue;
      const { session: _id, ...fields } = u;
      if (FINISHED.includes(u.status)) this.finish(s, u.status, u.message ?? (u.status === "done" ? "Connected." : "The sign-in didn't finish."));
      // Each report is the whole picture: what it leaves out is no longer shown.
      else this.sessions.set(s.provider, { id: s.id, provider: s.provider, startedAt: s.startedAt, ...fields, updatedAt: new Date().toISOString() });
    }
    if (!this.commands.length && waitMs > 0) {
      this.waiter?.();
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => done(), waitMs);
        const done = () => (clearTimeout(t), this.waiter === done && (this.waiter = undefined), resolve());
        this.waiter = done;
      });
    }
    this.lastPoll = Date.now();
    const out = this.commands;
    this.commands = [];
    return out;
  }

  private push(c: RunnerCommand) {
    this.commands.push(c);
    this.waiter?.();
  }

  private finish(s: SignInSession, status: SignInStatus, message: string): SignInSession {
    const { prompt: _p, url: _u, code: _c, ...rest } = s;
    const next = { ...rest, status, message, updatedAt: new Date().toISOString() };
    this.sessions.set(s.provider, next);
    return next;
  }
}
