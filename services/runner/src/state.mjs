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
      -- A task's branches across its workspace's repositories (D-41).
      CREATE TABLE IF NOT EXISTS branches (
        issue_id   TEXT NOT NULL,
        repo       TEXT NOT NULL,
        branch     TEXT NOT NULL,
        base       TEXT NOT NULL,
        purpose    TEXT,
        pushed     INTEGER NOT NULL DEFAULT 0,
        pr_url     TEXT,
        merged     INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (issue_id, repo, branch)
      );
    `);
    // The task's workspace directory (D-41); tasks from before it have only a worktree.
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'workspace'").get()) this.db.exec("ALTER TABLE tasks ADD COLUMN workspace TEXT");
  }

  branches(issueId) {
    return this.db.prepare("SELECT * FROM branches WHERE issue_id = ? ORDER BY repo, branch").all(issueId);
  }

  /** Record a branch the task has (insert or update its base and purpose). */
  saveBranch(issueId, { repo, branch, base, purpose }) {
    this.db
      .prepare("INSERT INTO branches (issue_id, repo, branch, base, purpose, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (issue_id, repo, branch) DO UPDATE SET base = excluded.base, purpose = COALESCE(NULLIF(excluded.purpose, ''), branches.purpose), updated_at = excluded.updated_at")
      .run(issueId, repo, branch, base, purpose ?? "", new Date().toISOString());
  }

  updateBranch(issueId, repo, branch, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE branches SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE issue_id = ? AND repo = ? AND branch = ?`).run(...keys.map((k) => fields[k] ?? null), new Date().toISOString(), issueId, repo, branch);
  }

  deleteBranch(issueId, repo, branch) {
    this.db.prepare("DELETE FROM branches WHERE issue_id = ? AND repo = ? AND branch = ?").run(issueId, repo, branch);
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

  /** The newest finished jobs, with their task's identifier. */
  /** The latest finished job of each task, newest first (D-45: a stuck part shows on the board). */
  latestJobs(limit) {
    return this.db
      .prepare("SELECT jobs.status, tasks.identifier FROM jobs JOIN tasks USING (issue_id) WHERE jobs.id IN (SELECT MAX(id) FROM jobs WHERE finished_at IS NOT NULL GROUP BY issue_id) ORDER BY jobs.id DESC LIMIT ?")
      .all(limit);
  }

  recentJobs(limit) {
    return this.db
      .prepare("SELECT jobs.*, tasks.identifier FROM jobs JOIN tasks USING (issue_id) WHERE jobs.finished_at IS NOT NULL ORDER BY jobs.id DESC LIMIT ?")
      .all(limit);
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
