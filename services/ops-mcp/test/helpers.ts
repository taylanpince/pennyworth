import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pino from "pino";
import { type App, createApp } from "../src/app.js";
import { type Config, ConfigSchema } from "../src/config.js";
import { openDb } from "../src/db/db.js";
import type { CalendarEvent } from "../src/matching/types.js";
import type { CreateIssueInput, IssueComment, IssueRef, PaperclipApi } from "../src/paperclip/api.js";

export const silentLog = pino({ level: "silent" });

export class FakePaperclip implements PaperclipApi {
  issues = new Map<string, IssueRef & { input: CreateIssueInput }>();
  byKey = new Map<string, string>();
  comments = new Map<string, IssueComment[]>();
  up = true;
  /** Simulates Paperclip refusing agent-key updates outside a heartbeat run. */
  refuseUpdates = false;
  private seq = 0;

  async createIssue(input: CreateIssueInput): Promise<IssueRef> {
    if (!this.up) throw new Error("paperclip down");
    const existing = this.byKey.get(input.idempotency_key);
    if (existing) return this.issues.get(existing)!;
    const id = `iss_${++this.seq}`;
    const issue = { id, identifier: `PEN-${this.seq}`, status: "todo", input };
    this.issues.set(id, issue);
    this.byKey.set(input.idempotency_key, id);
    return issue;
  }
  async getIssue(id: string): Promise<IssueRef> {
    return this.issues.get(id)!;
  }
  async listComments(issueId: string): Promise<IssueComment[]> {
    return this.comments.get(issueId) ?? [];
  }
  async addComment(issueId: string, body: string): Promise<void> {
    if (this.refuseUpdates) throw new Error("403 Cross-issue writes need a run");
    const list = this.comments.get(issueId) ?? [];
    list.push({ id: `c${list.length}`, body, author: "agent", created_at: new Date().toISOString() });
    this.comments.set(issueId, list);
  }
  userComment(issueId: string, body: string): void {
    const list = this.comments.get(issueId) ?? [];
    list.push({ id: `u${list.length}`, body, author: "user", created_at: new Date().toISOString() });
    this.comments.set(issueId, list);
  }
  async setStatus(issueId: string, status: string): Promise<void> {
    const i = this.issues.get(issueId);
    if (i) i.status = status;
  }
  async ping(): Promise<boolean> {
    return this.up;
  }
  routineRuns: string[] = [];
  async runRoutine(title: string): Promise<void> {
    this.routineRuns.push(title);
  }
  byLabel(label: string): (IssueRef & { input: CreateIssueInput })[] {
    return [...this.issues.values()].filter((i) => i.input.labels.includes(label));
  }
}

export interface Env {
  dir: string;
  transcripts: string;
  vault: string;
  cfg: Config;
  app: App;
  paperclip: FakePaperclip;
  now: { ms: number };
}

export function makeEnv(overrides: Partial<{ routing: string; cfg: Record<string, unknown> }> = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), "ops-mcp-test-"));
  const transcripts = join(dir, "transcripts");
  const vault = join(dir, "vault");
  mkdirSync(transcripts, { recursive: true });
  mkdirSync(join(vault, "Projects"), { recursive: true });
  mkdirSync(join(vault, "Meetings"), { recursive: true });
  mkdirSync(join(vault, "Personal"), { recursive: true });
  const routingPath = join(dir, "routing.yaml");
  writeFileSync(
    routingPath,
    overrides.routing ??
      `routes:
  - calendar_title_regex: "(?i)open money stack|\\\\boms\\\\b"
    target: "Projects/Open Money Stack.md"
  - calendar_title_regex: "(?i)agglayer"
    target: "Projects/Agglayer.md"
`,
  );
  const cfg = ConfigSchema.parse({
    timezone: "Europe/Madrid",
    self: { names: ["Taylan"], emails: ["taylan@example.com"] },
    transcripts: { roots: [transcripts], stability_seconds: 10 },
    vault: { root: vault, read_roots: ["Projects", "Meetings"], write_roots: ["Projects", "Meetings"] },
    routing: { config_path: routingPath },
    paperclip: { base_url: "http://paperclip.test:3100" },
    data: { db_path: ":memory:" },
    ...(overrides.cfg ?? {}),
  });
  const paperclip = new FakePaperclip();
  const now = { ms: Date.parse("2026-10-04T14:40:00+02:00") };
  const app = createApp(cfg, silentLog, { db: openDb(":memory:"), paperclip, now: () => now.ms });
  return { dir, transcripts, vault, cfg, app, paperclip, now };
}

/** Write a file and set its mtime (defaults to well in the past so it is stable). */
export function writeAt(path: string, content: string, mtime: string | number = "2026-10-04T14:32:00+02:00"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  const t = typeof mtime === "number" ? mtime / 1000 : Date.parse(mtime) / 1000;
  utimesSync(path, t, t);
}

export function event(partial: Partial<CalendarEvent> & { id: string; title: string; start: string; end: string }): CalendarEvent {
  return { attendees: [], attachments: [], ...partial };
}

export const people = (...names: string[]) =>
  names.map((n) => ({ name: n, email: `${n.toLowerCase()}@example.com`, self: n === "Taylan" }));

export const OMS_PRIVY = event({
  id: "evt_oms_nimbus_20261004",
  title: "OMS <> Nimbus Integration",
  start: "2026-10-04T14:00:00+02:00",
  end: "2026-10-04T14:30:00+02:00",
  attendees: people("Alice", "Bob", "Taylan"),
});

export const EXTRACTION = {
  summary: "Discussed integrating Nimbus embedded wallets into the Open Money Stack.",
  decisions: [{ text: "Use Nimbus for embedded wallet onboarding in the pilot", kind: "explicit" as const }],
  actions: [
    { owner: "Taylan", action: "Review the delegated signing proposal", deadline: null },
    { owner: "Alice", action: "Send revised architecture diagram", deadline: "Friday" },
  ],
  open_questions: ["Which chains are in scope for the pilot?"],
  context: [],
  people: ["Alice", "Bob"],
  topics: ["Open Money Stack", "Nimbus"],
};
