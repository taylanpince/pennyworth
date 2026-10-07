import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

/** Bucket and rank per Paperclip issue, read markers, and the rollover date. */
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

  /** Move one task to the top or bottom of a bucket. */
  move(issueId: string, bucket: Bucket, position: "top" | "bottom" = "top"): void {
    this.tx(() => this.put(issueId, bucket, position));
  }

  /** The full new order of one bucket (after a drag): ranks 0..n-1, moving tasks into it as needed. */
  setOrder(bucket: Bucket, ids: string[]): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "INSERT INTO placements (issue_id, bucket, rank, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(issue_id) DO UPDATE SET bucket = excluded.bucket, rank = excluded.rank, updated_at = excluded.updated_at",
    );
    this.tx(() => ids.forEach((id, i) => stmt.run(id, bucket, i, now)));
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
