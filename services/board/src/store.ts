import { createHash, randomBytes, randomInt } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Rule } from "./recurrence.js";

/** The board's own columns. Paperclip has no ordering or buckets, so these live here (D-22). */
export const BUCKETS = ["triage", "today", "tomorrow", "later", "backlog"] as const;
export type Bucket = (typeof BUCKETS)[number];
export const isBucket = (b: unknown): b is Bucket => typeof b === "string" && (BUCKETS as readonly string[]).includes(b);

/** The local calendar date (YYYY-MM-DD) in the user's timezone. */
export const localDate = (tz: string, at = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

export interface Placement {
  bucket: Bucket;
  rank: number;
}

export interface NewIssue {
  id: string;
  createdAt: string;
  /** Paperclip's own status: tasks already in Paperclip's backlog start in Backlog. */
  status: string;
}

export interface ScheduledMove {
  date: string;
  bucket: Bucket;
  position: "top" | "bottom";
}

export interface Recurring {
  issueId: string;
  rule: Rule;
  /** GitHub repositories (owner/name) whose activity the runner collects for each run. */
  repos: string[];
  nextRun: string | null;
  manualAt: string | null;
  paused: boolean;
  /** End of the window the last run covered: the next window starts here. */
  lastUntil: string | null;
}

export interface RecurringRun {
  issueId: string;
  /** Local date and time of the run ("2026-10-12T07:00"): one run per definition and occurrence. */
  occurrence: string;
  outputId: string;
  outputIdentifier: string;
  since: string;
  until: string;
  previous: string | null;
  state: "claimed" | "started" | "failed";
  attempts: number;
  claimedAt: string;
}

interface RunRow {
  issue_id: string;
  occurrence: string;
  output_id: string;
  output_identifier: string;
  since: string;
  until: string;
  previous: string | null;
  state: string;
  attempts: number;
  claimed_at: string;
}

const toRun = (r: RunRow): RecurringRun => ({
  issueId: r.issue_id,
  occurrence: r.occurrence,
  outputId: r.output_id,
  outputIdentifier: r.output_identifier,
  since: r.since,
  until: r.until,
  previous: r.previous,
  state: r.state as RecurringRun["state"],
  attempts: r.attempts,
  claimedAt: r.claimed_at,
});

/** Bucket and rank per Paperclip issue, read markers, the rollover date, scheduled moves and recurring tasks. */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS placements (issue_id TEXT PRIMARY KEY, bucket TEXT NOT NULL, rank REAL NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (issue_id TEXT PRIMARY KEY, seen_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, device TEXT NOT NULL, created_at TEXT NOT NULL, last_seen TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pairings (code_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduled_moves (issue_id TEXT PRIMARY KEY, date TEXT NOT NULL, bucket TEXT NOT NULL, position TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recurring (issue_id TEXT PRIMARY KEY, rule TEXT NOT NULL, repos TEXT NOT NULL, next_run TEXT, manual_at TEXT, paused INTEGER NOT NULL DEFAULT 0, last_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recurring_runs (issue_id TEXT NOT NULL, occurrence TEXT NOT NULL, output_id TEXT NOT NULL, output_identifier TEXT NOT NULL, since TEXT NOT NULL, until TEXT NOT NULL, previous TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, claimed_at TEXT NOT NULL, PRIMARY KEY (issue_id, occurrence));
    `);
    if (!this.meta("installed_at")) this.setMeta("installed_at", new Date().toISOString());
  }

  meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  placements(): Map<string, Placement> {
    const rows = this.db.prepare("SELECT issue_id, bucket, rank FROM placements").all() as { issue_id: string; bucket: string; rank: number }[];
    return new Map(rows.filter((r) => isBucket(r.bucket)).map((r) => [r.issue_id, { bucket: r.bucket as Bucket, rank: r.rank }]));
  }

  /** New tasks land at the top of Triage, newest first (Paperclip backlog tasks go to Backlog). */
  placeNew(issues: NewIssue[]): void {
    if (!issues.length) return;
    const known = this.placements();
    const fresh = issues.filter((i) => !known.has(i.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.tx(() => {
      for (const i of fresh) this.put(i.id, i.status === "backlog" ? "backlog" : "triage", "top");
    });
  }

  /** Move one task to the top or bottom of a bucket. A move by hand replaces a scheduled one. */
  move(issueId: string, bucket: Bucket, position: "top" | "bottom" = "top"): void {
    this.tx(() => {
      this.put(issueId, bucket, position);
      this.unschedule(issueId);
    });
  }

  /** The full new order of one bucket (after a drag): ranks 0..n-1, moving tasks into it as needed. */
  setOrder(bucket: Bucket, ids: string[]): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "INSERT INTO placements (issue_id, bucket, rank, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(issue_id) DO UPDATE SET bucket = excluded.bucket, rank = excluded.rank, updated_at = excluded.updated_at",
    );
    const before = this.placements();
    this.tx(() =>
      ids.forEach((id, i) => {
        stmt.run(id, bucket, i, now);
        // Dragged here from another column: that replaces a scheduled move.
        if (before.get(id)?.bucket !== bucket) this.unschedule(id);
      }),
    );
  }

  // ---------------------------------------------------------------- scheduled moves (D-25)

  /** On `date` (local), move the task to the top or bottom of `bucket`. One schedule per task. */
  schedule(issueId: string, date: string, bucket: Bucket, position: "top" | "bottom" = "top"): void {
    this.db
      .prepare(
        "INSERT INTO scheduled_moves (issue_id, date, bucket, position, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(issue_id) DO UPDATE SET date = excluded.date, bucket = excluded.bucket, position = excluded.position, created_at = excluded.created_at",
      )
      .run(issueId, date, bucket, position, new Date().toISOString());
  }

  unschedule(issueId: string): boolean {
    return Number(this.db.prepare("DELETE FROM scheduled_moves WHERE issue_id = ?").run(issueId).changes) > 0;
  }

  schedules(): Map<string, ScheduledMove> {
    const rows = this.db.prepare("SELECT issue_id, date, bucket, position FROM scheduled_moves").all() as { issue_id: string; date: string; bucket: string; position: string }[];
    return new Map(rows.filter((r) => isBucket(r.bucket)).map((r) => [r.issue_id, { date: r.date, bucket: r.bucket as Bucket, position: r.position === "bottom" ? "bottom" : "top" }]));
  }

  /** Apply the moves due on or before `today` (catching up after downtime). Returns the moved task ids. */
  applySchedules(today: string): string[] {
    const due = this.db.prepare("SELECT issue_id, bucket, position FROM scheduled_moves WHERE date <= ? ORDER BY date, created_at").all(today) as { issue_id: string; bucket: string; position: string }[];
    this.tx(() => {
      for (const r of due) {
        if (isBucket(r.bucket)) this.put(r.issue_id, r.bucket, r.position === "bottom" ? "bottom" : "top");
        this.unschedule(r.issue_id);
      }
    });
    return due.map((r) => r.issue_id);
  }

  // ---------------------------------------------------------------- recurring tasks (D-25)

  setRecurring(issueId: string, rule: Rule, repos: string[], nextRun: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO recurring (issue_id, rule, repos, next_run, paused, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?) ON CONFLICT(issue_id) DO UPDATE SET rule = excluded.rule, repos = excluded.repos, next_run = excluded.next_run, paused = 0, updated_at = excluded.updated_at",
      )
      .run(issueId, JSON.stringify(rule), JSON.stringify(repos), nextRun, now, now);
  }

  recurring(issueId: string): Recurring | undefined {
    return this.allRecurring().get(issueId);
  }

  allRecurring(): Map<string, Recurring> {
    const rows = this.db.prepare("SELECT issue_id, rule, repos, next_run, manual_at, paused, last_until FROM recurring").all() as {
      issue_id: string;
      rule: string;
      repos: string;
      next_run: string | null;
      manual_at: string | null;
      paused: number;
      last_until: string | null;
    }[];
    return new Map(
      rows.map((r) => [
        r.issue_id,
        { issueId: r.issue_id, rule: JSON.parse(r.rule) as Rule, repos: JSON.parse(r.repos) as string[], nextRun: r.next_run, manualAt: r.manual_at, paused: r.paused === 1, lastUntil: r.last_until },
      ]),
    );
  }

  /**
   * Pause (no next run, any "run now" dropped) or resume with the given next run. After a pause the
   * next window is one period again, not everything since the last run.
   */
  setPaused(issueId: string, paused: boolean, nextRun: string | null): void {
    const now = new Date().toISOString();
    if (paused) this.db.prepare("UPDATE recurring SET paused = 1, next_run = NULL, manual_at = NULL, updated_at = ? WHERE issue_id = ?").run(now, issueId);
    else this.db.prepare("UPDATE recurring SET paused = 0, next_run = ?, last_until = NULL, updated_at = ? WHERE issue_id = ?").run(nextRun, now, issueId);
  }

  /** Move the rule on without a run (this occurrence already ran). */
  skipTo(issueId: string, nextRun: string): void {
    this.db.prepare("UPDATE recurring SET next_run = ?, manual_at = NULL, updated_at = ? WHERE issue_id = ?").run(nextRun, new Date().toISOString(), issueId);
  }

  /** An extra run the next time the runner checks. */
  runNow(issueId: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE recurring SET manual_at = ?, updated_at = ? WHERE issue_id = ?").run(now, now, issueId);
  }

  stopRecurring(issueId: string): boolean {
    return Number(this.db.prepare("DELETE FROM recurring WHERE issue_id = ?").run(issueId).changes) > 0;
  }

  /** Recurring tasks with a run due at `now` (scheduled or "run now"); paused ones are left out. */
  dueRecurring(now: string): Recurring[] {
    return [...this.allRecurring().values()].filter((r) => !r.paused && ((r.nextRun !== null && r.nextRun <= now) || r.manualAt !== null));
  }

  /**
   * Record a claimed run and move the rule on: the next run after now, any "run now" cleared, and
   * for a scheduled run the end of the window just covered (where the next window starts).
   */
  claimRun(run: Omit<RecurringRun, "state" | "attempts">, nextRun: string, scheduled = true): void {
    this.tx(() => {
      this.db
        .prepare("INSERT INTO recurring_runs (issue_id, occurrence, output_id, output_identifier, since, until, previous, state, attempts, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'claimed', 1, ?)")
        .run(run.issueId, run.occurrence, run.outputId, run.outputIdentifier, run.since, run.until, run.previous, run.claimedAt);
      if (scheduled) this.db.prepare("UPDATE recurring SET next_run = ?, last_until = ?, manual_at = NULL, updated_at = ? WHERE issue_id = ?").run(nextRun, run.until, new Date().toISOString(), run.issueId);
      else this.db.prepare("UPDATE recurring SET next_run = ?, manual_at = NULL, updated_at = ? WHERE issue_id = ?").run(nextRun, new Date().toISOString(), run.issueId);
    });
  }

  run(issueId: string, occurrence: string): RecurringRun | undefined {
    const r = this.db.prepare("SELECT * FROM recurring_runs WHERE issue_id = ? AND occurrence = ?").get(issueId, occurrence) as unknown as RunRow | undefined;
    return r && toRun(r);
  }

  /** Runs claimed but not started within `staleMs` (the runner stopped mid-way), handed out again a few times. */
  retryRuns(staleMs: number, maxAttempts: number): RecurringRun[] {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const rows = this.db.prepare("SELECT * FROM recurring_runs WHERE state = 'claimed' AND claimed_at < ? AND attempts < ?").all(cutoff, maxAttempts) as unknown as RunRow[];
    const now = new Date().toISOString();
    const stmt = this.db.prepare("UPDATE recurring_runs SET attempts = attempts + 1, claimed_at = ? WHERE issue_id = ? AND occurrence = ?");
    this.tx(() => rows.forEach((r) => stmt.run(now, r.issue_id, r.occurrence)));
    return rows.map((r) => ({ ...toRun(r), attempts: r.attempts + 1, claimedAt: now }));
  }

  /** Claimed runs that were never started and are out of attempts. */
  abandonedRuns(staleMs: number, maxAttempts: number): RecurringRun[] {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    return (this.db.prepare("SELECT * FROM recurring_runs WHERE state = 'claimed' AND claimed_at < ? AND attempts >= ?").all(cutoff, maxAttempts) as unknown as RunRow[]).map(toRun);
  }

  setRunState(issueId: string, occurrence: string, state: "started" | "failed"): boolean {
    return Number(this.db.prepare("UPDATE recurring_runs SET state = ? WHERE issue_id = ? AND occurrence = ?").run(state, issueId, occurrence).changes) > 0;
  }

  /** The output task of the latest run so far (the next run builds on it). */
  lastOutput(issueId: string): string | undefined {
    return (this.db.prepare("SELECT output_identifier FROM recurring_runs WHERE issue_id = ? ORDER BY until DESC LIMIT 1").get(issueId) as { output_identifier: string } | undefined)?.output_identifier;
  }

  /**
   * Midnight rollover: on the first check of a new local day, Tomorrow joins Today below what's
   * already there (unfinished Today tasks stay on top). Returns how many tasks moved.
   */
  rollover(today: string): number {
    const last = this.meta("rollover_date");
    if (last === today) return 0;
    let moved = 0;
    this.tx(() => {
      if (last && last < today) {
        const max = (this.db.prepare("SELECT MAX(rank) AS m FROM placements WHERE bucket = 'today'").get() as { m: number | null }).m ?? -1;
        const rows = this.db.prepare("SELECT issue_id FROM placements WHERE bucket = 'tomorrow' ORDER BY rank").all() as { issue_id: string }[];
        const stmt = this.db.prepare("UPDATE placements SET bucket = 'today', rank = ?, updated_at = ? WHERE issue_id = ?");
        const now = new Date().toISOString();
        rows.forEach((r, i) => stmt.run(max + 1 + i, now, r.issue_id));
        moved = rows.length;
      }
      this.setMeta("rollover_date", today);
    });
    return moved;
  }

  seenAt(issueId: string): string {
    return (this.db.prepare("SELECT seen_at FROM seen WHERE issue_id = ?").get(issueId) as { seen_at: string } | undefined)?.seen_at ?? this.meta("installed_at")!;
  }

  allSeen(): Map<string, string> {
    return new Map((this.db.prepare("SELECT issue_id, seen_at FROM seen").all() as { issue_id: string; seen_at: string }[]).map((r) => [r.issue_id, r.seen_at]));
  }

  markSeen(issueId: string, at = new Date().toISOString()): void {
    this.db.prepare("INSERT INTO seen (issue_id, seen_at) VALUES (?, ?) ON CONFLICT(issue_id) DO UPDATE SET seen_at = MAX(seen_at, excluded.seen_at)").run(issueId, at);
  }

  // ---------------------------------------------------------------- paired devices (LAN access)

  /**
   * A one-time pairing code, valid for a few minutes; only its hash is stored. Eight characters
   * without look-alikes, short enough to type on a phone; failed attempts are
   * rate-limited in app.ts.
   */
  createPairing(ttlMs = 10 * 60_000): { code: string; expiresAt: string } {
    const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db.prepare("DELETE FROM pairings WHERE expires_at < ?").run(new Date().toISOString());
    this.db.prepare("INSERT INTO pairings (code_hash, expires_at) VALUES (?, ?)").run(sha256(code), expiresAt);
    return { code, expiresAt };
  }

  /** Spend a pairing code and open a session for the device; the session token is returned once. */
  pair(code: string, device: string): string | undefined {
    const row = this.db.prepare("DELETE FROM pairings WHERE code_hash = ? RETURNING expires_at").get(sha256(normalizeCode(code))) as { expires_at: string } | undefined;
    if (!row || row.expires_at < new Date().toISOString()) return undefined;
    const token = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO sessions (id, token_hash, device, created_at, last_seen) VALUES (?, ?, ?, ?, ?)").run(randomBytes(8).toString("hex"), sha256(token), device.slice(0, 80) || "Device", now, now);
    return token;
  }

  /** Whether a session token is valid (and note when it was last used, at most once a minute). */
  checkSession(token: string | undefined): boolean {
    if (!token) return false;
    const hash = sha256(token);
    const row = this.db.prepare("SELECT last_seen FROM sessions WHERE token_hash = ?").get(hash) as { last_seen: string } | undefined;
    if (!row) return false;
    if (Date.now() - Date.parse(row.last_seen) > 60_000) this.db.prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?").run(new Date().toISOString(), hash);
    return true;
  }

  devices(): { id: string; device: string; createdAt: string; lastSeen: string }[] {
    return (this.db.prepare("SELECT id, device, created_at, last_seen FROM sessions ORDER BY created_at").all() as { id: string; device: string; created_at: string; last_seen: string }[]).map((r) => ({
      id: r.id,
      device: r.device,
      createdAt: r.created_at,
      lastSeen: r.last_seen,
    }));
  }

  revokeDevice(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes) > 0;
  }

  close(): void {
    this.db.close();
  }

  private put(issueId: string, bucket: Bucket, position: "top" | "bottom"): void {
    const agg = position === "top" ? "MIN(rank) - 1" : "MAX(rank) + 1";
    const rank = (this.db.prepare(`SELECT ${agg} AS r FROM placements WHERE bucket = ? AND issue_id != ?`).get(bucket, issueId) as { r: number | null }).r ?? 0;
    this.db
      .prepare("INSERT INTO placements (issue_id, bucket, rank, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(issue_id) DO UPDATE SET bucket = excluded.bucket, rank = excluded.rank, updated_at = excluded.updated_at")
      .run(issueId, bucket, rank, new Date().toISOString());
  }

  private tx(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Letters and digits without the look-alikes 0/O and 1/I/L (31 characters, ~39.6 bits for 8).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** "k7qm-3xwp" → "K7QM3XWP": case, spaces and dashes don't matter when typing a code. */
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
