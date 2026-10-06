import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Durable runner state: per-task workspace/session and processed comment IDs. */
export class State {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, "state.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        issue_id    TEXT PRIMARY KEY,
        identifier  TEXT NOT NULL,
        first_seen  TEXT NOT NULL,
        repo        TEXT,
        base        TEXT,
        branch      TEXT,
        worktree    TEXT,
        engine_json TEXT,
        mode        TEXT,
        shells_json TEXT,
        session_id  TEXT,
        pushed      INTEGER NOT NULL DEFAULT 0,
        pr_url      TEXT,
        updated_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comments (
        comment_id TEXT PRIMARY KEY,
        issue_id   TEXT NOT NULL,
        handled_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id    TEXT NOT NULL,
        status      TEXT NOT NULL,
        engine      TEXT,
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        log_path    TEXT,
        detail      TEXT
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);
  }

  task(issueId) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE issue_id = ?").get(issueId);
    if (!row) return undefined;
    return { ...row, engine: row.engine_json ? JSON.parse(row.engine_json) : undefined, shells: row.shells_json ? JSON.parse(row.shells_json) : undefined };
  }

  ensureTask(issueId, identifier) {
    const now = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO tasks (issue_id, identifier, first_seen, updated_at) VALUES (?, ?, ?, ?)").run(issueId, identifier, now, now);
    return this.task(issueId);
  }

  updateTask(issueId, fields) {
    const map = { ...fields };
    if ("engine" in map) (map.engine_json = JSON.stringify(map.engine)), delete map.engine;
    if ("shells" in map) (map.shells_json = JSON.stringify(map.shells)), delete map.shells;
    map.updated_at = new Date().toISOString();
    const keys = Object.keys(map);
    this.db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE issue_id = ?`).run(...keys.map((k) => map[k] ?? null), issueId);
  }

  handled(commentId) {
    return Boolean(this.db.prepare("SELECT 1 FROM comments WHERE comment_id = ?").get(commentId));
  }

  markHandled(commentId, issueId) {
    this.db.prepare("INSERT OR IGNORE INTO comments (comment_id, issue_id, handled_at) VALUES (?, ?, ?)").run(commentId, issueId, new Date().toISOString());
  }

  startJob(issueId, engine, logPath) {
    return Number(
      this.db.prepare("INSERT INTO jobs (issue_id, status, engine, started_at, log_path) VALUES (?, 'running', ?, ?, ?)").run(issueId, engine, new Date().toISOString(), logPath).lastInsertRowid,
    );
  }

  finishJob(id, status, detail) {
    this.db.prepare("UPDATE jobs SET status = ?, finished_at = ?, detail = ? WHERE id = ?").run(status, new Date().toISOString(), detail ?? null, id);
  }

  lastJob(issueId) {
    return this.db.prepare("SELECT * FROM jobs WHERE issue_id = ? ORDER BY id DESC LIMIT 1").get(issueId);
  }

  /** Jobs left 'running' by a crash or restart are marked interrupted at startup. */
  interruptStale() {
    return this.db.prepare("UPDATE jobs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(new Date().toISOString()).changes;
  }

  get(key) {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
  }

  set(key, value) {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }
}
