// Memory (D-61): what the user taught the agents, in the board's SQLite. Three scopes: rules for every
// agent ("global"), each crew member's own lessons and playbooks (its setup key: "assistant", "writer",
// "sre"…), and past tasks (episodes) to find earlier work by. Only the user's word writes an active
// memory: their explicit "remember", or a proposal they accepted on the board. Limits, the secret
// check, deduplication, ordering and the recall budget are here, in code; the routes are memoryapi.ts.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/** The kinds, in the order recall lists them: rules first, then facts, lessons and playbooks. */
export const KINDS = ["rule", "fact", "lesson", "playbook"] as const;
export type Kind = (typeof KINDS)[number];
export const isKind = (k: unknown): k is Kind => typeof k === "string" && (KINDS as readonly string[]).includes(k);

export const STATUSES = ["active", "proposed", "rejected", "archived"] as const;
export type Status = (typeof STATUSES)[number];
export type Origin = "remember" | "proposal" | "board";

export const GLOBAL = "global";
/** A scope: "global", or a crew member's setup key without `pennyworth:`. */
export const SCOPE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Characters per memory: a rule, fact or lesson is a sentence or two; a playbook is short numbered steps. */
export const LIMITS: Record<Kind, number> = { rule: 600, fact: 600, lesson: 600, playbook: 4000 };
export const WHY_LIMIT = 300;
/** Characters of recall per section: the global rules, and the agent's own. */
export const BUDGETS = { global: 6000, own: 8000 };
const EPISODE_SUMMARY = 1200;

export interface Memory {
  id: number;
  scope: string;
  kind: Kind;
  text: string;
  status: Status;
  pinned: boolean;
  sensitive: boolean;
  origin: Origin;
  createdBy: string | null;
  why: string | null;
  sourceIssue: string | null;
  sourceComment: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  lastUsedAt: string | null;
  uses: number;
}

export interface Episode {
  issueId: string;
  identifier: string;
  title: string;
  scope: string;
  summary: string;
  links: string[];
  closedAt: string;
}

/** A memory that can't be stored as given; the message says why, for the agent or the user. */
export class MemoryRefused extends Error {}

interface Row {
  id: number;
  scope: string;
  kind: string;
  text: string;
  status: string;
  pinned: number;
  sensitive: number;
  origin: string;
  created_by: string | null;
  why: string | null;
  source_issue: string | null;
  source_comment: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  last_used_at: string | null;
  uses: number;
}

const toMemory = (r: Row): Memory => ({
  id: r.id,
  scope: r.scope,
  kind: r.kind as Kind,
  text: r.text,
  status: r.status as Status,
  pinned: r.pinned === 1,
  sensitive: r.sensitive === 1,
  origin: r.origin as Origin,
  createdBy: r.created_by,
  why: r.why,
  sourceIssue: r.source_issue,
  sourceComment: r.source_comment,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  decidedAt: r.decided_at,
  lastUsedAt: r.last_used_at,
  uses: r.uses,
});

interface EpisodeRow {
  issue_id: string;
  identifier: string;
  title: string;
  scope: string;
  summary: string;
  links: string;
  closed_at: string;
}

const toEpisode = (r: EpisodeRow): Episode => ({ issueId: r.issue_id, identifier: r.identifier, title: r.title, scope: r.scope, summary: r.summary, links: JSON.parse(r.links) as string[], closedAt: r.closed_at });

/** Text as stored: hidden comments gone, line ends and blank lines tidied, trimmed. */
export function normalizeText(text: string): string {
  return String(text ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** What makes two memories the same: case, spacing and a final full stop don't count. */
const sameKey = (text: string) => text.toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/, "").trim();

const SECRETS: [RegExp, string][] = [
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "an API key"],
  [/\bpcp_[a-f0-9]{20,}/, "a Paperclip key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/GOCSP[X]-[A-Za-z0-9_-]{10,}/, "a Google client secret"],
  [/-----BEGIN [A-Z0-9 ]*KEY-----/, "a private key"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, "a token (JWT)"],
  // A long hex or base64 run next to a word that says what it is.
  [/\b(api[_ -]?key|access[_ -]?key|key|token|secret|password|passwd|passphrase|credential)s?\b[^\n]{0,40}?[A-Za-z0-9+/_=-]{40,}/i, "a credential"],
  [/[A-Za-z0-9+/_=-]{40,}[^\n]{0,20}?\b(api[_ -]?key|access[_ -]?key|key|token|secret|password|passwd|passphrase|credential)s?\b/i, "a credential"],
];

/** What kind of secret the text seems to hold, or undefined. Memories never hold credentials. */
export function secretIn(text: string): string | undefined {
  return SECRETS.find(([re]) => re.test(text))?.[1];
}

/** The text to store for a memory of this kind, or MemoryRefused saying why not. */
export function checkText(kind: Kind, raw: string): string {
  const text = normalizeText(raw);
  if (!text) throw new MemoryRefused("the memory is empty");
  if (text.length > LIMITS[kind]) throw new MemoryRefused(`a ${kind} is at most ${LIMITS[kind]} characters (this one has ${text.length}): ${kind === "playbook" ? "keep the steps short" : "say it in a sentence or two"}`);
  const secret = secretIn(text);
  if (secret) throw new MemoryRefused(`it looks like it contains ${secret}: memories never hold credentials`);
  return text;
}

function checkWhy(raw: string | null | undefined): string | null {
  const why = normalizeText(raw ?? "");
  if (!why) return null;
  if (why.length > WHY_LIMIT) throw new MemoryRefused(`the reason is at most ${WHY_LIMIT} characters`);
  if (secretIn(why)) throw new MemoryRefused("the reason looks like it contains a credential");
  return why;
}

export interface NewMemory {
  scope: string;
  kind: Kind;
  text: string;
  status: "active" | "proposed";
  origin: Origin;
  createdBy?: string | null;
  why?: string | null;
  sourceIssue?: string | null;
  sourceComment?: string | null;
  pinned?: boolean;
  sensitive?: boolean;
}

export interface MemoryPatch {
  text?: string;
  kind?: Kind;
  scope?: string;
  pinned?: boolean;
  sensitive?: boolean;
  status?: Status;
}

export interface Recall {
  /** Markdown, ready to put in a prompt: a section for everyone's rules and one for the agent's own. "" when there's nothing. */
  text: string;
  count: number;
  omitted: number;
}

/** One section's budget: what fits, in order, and what's left out. */
export interface Budget {
  used: number;
  budget: number;
  included: number[];
  omitted: number[];
}

const firstLine = (text: string) => text.split("\n").find((l) => l.trim())?.trim() ?? "";

/** One memory as a recall line: `- [id] text`; a playbook by its first line, its steps a search away. */
export function recallLine(m: Pick<Memory, "id" | "kind" | "text">): string {
  if (m.kind === "playbook") return `- [${m.id}] Playbook: ${firstLine(m.text).replace(/^#+\s*/, "").slice(0, 200)} (its steps: search memory for #${m.id})`;
  return `- [${m.id}] ${m.text.replace(/\n/g, "\n  ")}`;
}

/** Search words: letters and digits only, so nothing in a query is FTS syntax. */
const words = (query: string) => [...new Set((String(query ?? "").match(/[\p{L}\p{N}_]+/gu) ?? []).map((w) => w.toLowerCase()))].slice(0, 12);

export class MemoryStore {
  /** Whether SQLite's FTS5 is there (Node's bundled SQLite has it); search falls back to LIKE without it. */
  readonly fts: boolean;

  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('rule', 'lesson', 'playbook', 'fact')),
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'proposed', 'rejected', 'archived')),
        pinned INTEGER NOT NULL DEFAULT 0,
        sensitive INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL CHECK (origin IN ('remember', 'proposal', 'board')),
        created_by TEXT,
        why TEXT,
        source_issue TEXT,
        source_comment TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT,
        last_used_at TEXT,
        uses INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS memories_scope ON memories (scope, status);
      CREATE INDEX IF NOT EXISTS memories_source ON memories (source_issue, origin, created_at);
      CREATE TABLE IF NOT EXISTS episodes (issue_id TEXT PRIMARY KEY, identifier TEXT NOT NULL, title TEXT NOT NULL, scope TEXT NOT NULL, summary TEXT NOT NULL, links TEXT NOT NULL DEFAULT '[]', closed_at TEXT NOT NULL);
    `);
    let fts = true;
    try {
      // Standalone FTS tables keyed by an unindexed column, kept in step by triggers.
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, text, tokenize = 'porter unicode61');
        CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN INSERT INTO memories_fts (memory_id, text) VALUES (new.id, new.text); END;
        CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF text ON memories BEGIN DELETE FROM memories_fts WHERE memory_id = old.id; INSERT INTO memories_fts (memory_id, text) VALUES (new.id, new.text); END;
        CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN DELETE FROM memories_fts WHERE memory_id = old.id; END;
        CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(issue_id UNINDEXED, title, summary, tokenize = 'porter unicode61');
        CREATE TRIGGER IF NOT EXISTS episodes_fts_insert AFTER INSERT ON episodes BEGIN INSERT INTO episodes_fts (issue_id, title, summary) VALUES (new.issue_id, new.title, new.summary); END;
        CREATE TRIGGER IF NOT EXISTS episodes_fts_delete AFTER DELETE ON episodes BEGIN DELETE FROM episodes_fts WHERE issue_id = old.issue_id; END;
      `);
    } catch {
      fts = false;
    }
    this.fts = fts;
  }

  get(id: number): Memory | undefined {
    const r = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as unknown as Row | undefined;
    return r && toMemory(r);
  }

  /** Every memory matching the filters, in recall order within each scope. */
  list(filter: { scope?: string; status?: Status; kind?: Kind; q?: string } = {}): Memory[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.scope) (where.push("scope = ?"), args.push(filter.scope));
    if (filter.status) (where.push("status = ?"), args.push(filter.status));
    if (filter.kind) (where.push("kind = ?"), args.push(filter.kind));
    for (const w of words(filter.q ?? "")) (where.push("(lower(text) LIKE ? OR lower(coalesce(why, '')) LIKE ?)"), args.push(`%${w}%`, `%${w}%`));
    const rows = this.db.prepare(`SELECT * FROM memories ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${ORDER}`).all(...args) as unknown as Row[];
    return rows.map(toMemory);
  }

  /**
   * Store a memory. The same text in the same scope (case, spacing and a final full stop aside) returns
   * the row already there: a proposal of it stays as it is, and an active one (the user's word) makes a
   * proposed, rejected or archived one active again.
   */
  add(input: NewMemory): { memory: Memory; duplicate: boolean } {
    if (!SCOPE.test(input.scope)) throw new MemoryRefused(`unknown scope ${input.scope}`);
    if (!isKind(input.kind)) throw new MemoryRefused(`the kind is one of ${KINDS.join(", ")}`);
    const text = checkText(input.kind, input.text);
    const why = checkWhy(input.why);
    const existing = this.list({ scope: input.scope }).find((m) => sameKey(m.text) === sameKey(text));
    if (existing) {
      if (input.status === "active" && existing.status !== "active") return { memory: this.update(existing.id, { status: "active" }), duplicate: true };
      return { memory: existing, duplicate: true };
    }
    const now = new Date().toISOString();
    const r = this.db
      .prepare(
        "INSERT INTO memories (scope, kind, text, status, pinned, sensitive, origin, created_by, why, source_issue, source_comment, created_at, updated_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(input.scope, input.kind, text, input.status, input.pinned ? 1 : 0, input.sensitive ? 1 : 0, input.origin, input.createdBy ?? null, why, input.sourceIssue ?? null, input.sourceComment ?? null, now, now, input.status === "active" ? now : null) as { id: number };
    return { memory: this.get(r.id)!, duplicate: false };
  }

  /** Change a memory; a decision on a proposal (active, rejected) is timed. */
  update(id: number, patch: MemoryPatch): Memory {
    const m = this.get(id);
    if (!m) throw new MemoryRefused("no such memory");
    const kind = patch.kind ?? m.kind;
    if (!isKind(kind)) throw new MemoryRefused(`the kind is one of ${KINDS.join(", ")}`);
    const text = patch.text !== undefined || patch.kind !== undefined ? checkText(kind, patch.text ?? m.text) : m.text;
    const scope = patch.scope ?? m.scope;
    if (!SCOPE.test(scope)) throw new MemoryRefused(`unknown scope ${scope}`);
    if (patch.status !== undefined && !(STATUSES as readonly string[]).includes(patch.status)) throw new MemoryRefused(`the status is one of ${STATUSES.join(", ")}`);
    if ((scope !== m.scope || text !== m.text) && this.list({ scope }).some((o) => o.id !== id && sameKey(o.text) === sameKey(text))) throw new MemoryRefused(`the same memory is already there in ${scope}`);
    const status = patch.status ?? m.status;
    const now = new Date().toISOString();
    const decided = status !== m.status && (status === "active" || status === "rejected") ? now : m.decidedAt;
    this.db
      .prepare("UPDATE memories SET scope = ?, kind = ?, text = ?, status = ?, pinned = ?, sensitive = ?, updated_at = ?, decided_at = ? WHERE id = ?")
      .run(scope, kind, text, status, (patch.pinned ?? m.pinned) ? 1 : 0, (patch.sensitive ?? m.sensitive) ? 1 : 0, now, decided, id);
    return this.get(id)!;
  }

  remove(id: number): boolean {
    return Number(this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes) > 0;
  }

  /** How many memories of this origin a task gave rise to since `since` (the per-task caps). */
  countFrom(sourceIssue: string, origin: Origin, since: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE source_issue = ? AND origin = ? AND created_at >= ?").get(sourceIssue, origin, since) as { n: number }).n;
  }

  /** Proposals waiting for the user, in one scope or all. */
  pending(scope?: string): number {
    const row = scope
      ? this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'proposed' AND scope = ?").get(scope)
      : this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'proposed'").get();
    return (row as { n: number }).n;
  }

  // ---------------------------------------------------------------- recall

  /** Active memories for an agent: everyone's and its own; private (sensitive) ones never for OpenRouter. */
  private active(scope: string | null, engine?: string): Memory[] {
    const scopes = scope && scope !== GLOBAL ? [GLOBAL, scope] : [GLOBAL];
    const rows = this.db.prepare(`SELECT * FROM memories WHERE status = 'active' AND scope IN (${scopes.map(() => "?").join(", ")}) ${engine === "openrouter" ? "AND sensitive = 0" : ""} ORDER BY ${ORDER}`).all(...scopes) as unknown as Row[];
    return rows.map(toMemory);
  }

  /** What fits in a section's budget, in order; the rest is left out (and counted). */
  private fit(list: Memory[], budget: number): Budget & { lines: string[] } {
    const out: Budget & { lines: string[] } = { used: 0, budget, included: [], omitted: [], lines: [] };
    for (const m of list) {
      const line = recallLine(m);
      if (out.omitted.length || out.used + line.length + 1 > budget) {
        out.omitted.push(m.id);
        continue;
      }
      out.used += line.length + 1;
      out.included.push(m.id);
      out.lines.push(line);
    }
    return out;
  }

  /**
   * The memories an agent works with, as prompt text: everyone's rules, then its own, each within its
   * budget. Pinned first, then rules, facts, lessons and playbooks, newest first. Marks them used.
   */
  recall(scope: string | null, opts: { engine?: string } = {}): Recall {
    const all = this.active(scope, opts.engine);
    const global = this.fit(all.filter((m) => m.scope === GLOBAL), BUDGETS.global);
    const own = scope && scope !== GLOBAL ? this.fit(all.filter((m) => m.scope === scope), BUDGETS.own) : undefined;
    const sections = [
      global.lines.length || global.omitted.length ? `### For every agent\n\n${global.lines.join("\n")}${more(global.omitted.length)}` : "",
      own && (own.lines.length || own.omitted.length) ? `### Yours\n\n${own.lines.join("\n")}${more(own.omitted.length)}` : "",
    ].filter(Boolean);
    const used = [...global.included, ...(own?.included ?? [])];
    if (used.length) {
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE memories SET last_used_at = ? WHERE id IN (${used.map(() => "?").join(", ")})`).run(now, ...used);
    }
    return { text: sections.join("\n\n"), count: used.length, omitted: global.omitted.length + (own?.omitted.length ?? 0) };
  }

  /** Each scope's recall budget as the board shows it (what an agent on Claude Code or Codex gets). */
  budgets(scopes: string[]): Record<string, Budget> {
    const out: Record<string, Budget> = {};
    for (const scope of new Set([GLOBAL, ...scopes])) {
      const { lines: _lines, ...b } = this.fit(this.active(scope).filter((m) => m.scope === scope), scope === GLOBAL ? BUDGETS.global : BUDGETS.own);
      out[scope] = b;
    }
    return out;
  }

  // ---------------------------------------------------------------- search

  /**
   * Active memories (everyone's and the agent's own) and past tasks (every agent's) matching a query,
   * best first. "#12" or "12" gets memory 12 in full. A hit counts as a use.
   */
  search(scope: string | null, query: string, opts: { limit?: number; engine?: string } = {}): { memories: Memory[]; episodes: Episode[] } {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    const allowed = (m: Memory) => m.status === "active" && (m.scope === GLOBAL || m.scope === scope) && !(opts.engine === "openrouter" && m.sensitive);
    const byId = /^\s*#?(\d{1,9})\s*$/.exec(query);
    let memories: Memory[];
    let episodes: Episode[] = [];
    if (byId) {
      const m = this.get(Number(byId[1]));
      memories = m && allowed(m) ? [m] : [];
    } else {
      const w = words(query);
      if (!w.length) return { memories: [], episodes: [] };
      memories = this.matchMemories(w).filter(allowed).slice(0, limit);
      episodes = this.matchEpisodes(w, limit);
    }
    if (memories.length) {
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE memories SET uses = uses + 1, last_used_at = ? WHERE id IN (${memories.map(() => "?").join(", ")})`).run(now, ...memories.map((m) => m.id));
      memories = memories.map((m) => this.get(m.id)!);
    }
    return { memories, episodes };
  }

  private matchMemories(w: string[]): Memory[] {
    if (this.fts) {
      const ids = this.db.prepare("SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT 200").all(w.map((x) => `"${x}"*`).join(" OR ")) as { memory_id: number }[];
      return ids.map((r) => this.get(Number(r.memory_id))).filter((m): m is Memory => Boolean(m));
    }
    const rows = this.db.prepare(`SELECT * FROM memories WHERE ${w.map(() => "lower(text) LIKE ?").join(" OR ")}`).all(...w.map((x) => `%${x}%`)) as unknown as Row[];
    return rankByWords(rows.map(toMemory), w, (m) => m.text);
  }

  private matchEpisodes(w: string[], limit: number): Episode[] {
    if (this.fts) {
      const ids = this.db.prepare("SELECT issue_id FROM episodes_fts WHERE episodes_fts MATCH ? ORDER BY bm25(episodes_fts, 0, 2.0, 1.0) LIMIT ?").all(w.map((x) => `"${x}"*`).join(" OR "), limit) as { issue_id: string }[];
      return ids.map((r) => this.episode(String(r.issue_id))).filter((e): e is Episode => Boolean(e));
    }
    const rows = this.db.prepare(`SELECT * FROM episodes WHERE ${w.map(() => "(lower(title) LIKE ? OR lower(summary) LIKE ?)").join(" OR ")}`).all(...w.flatMap((x) => [`%${x}%`, `%${x}%`])) as unknown as EpisodeRow[];
    return rankByWords(rows.map(toEpisode), w, (e) => `${e.title} ${e.summary}`).slice(0, limit);
  }

  // ---------------------------------------------------------------- past tasks

  episode(issueId: string): Episode | undefined {
    const r = this.db.prepare("SELECT * FROM episodes WHERE issue_id = ?").get(issueId) as unknown as EpisodeRow | undefined;
    return r && toEpisode(r);
  }

  hasEpisode(issueId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM episodes WHERE issue_id = ?").get(issueId));
  }

  /** Record a finished task once; a second call for it changes nothing. Returns whether it was new. */
  addEpisode(e: Episode): boolean {
    const summary = normalizeText(e.summary);
    const cut = summary.length > EPISODE_SUMMARY ? `${summary.slice(0, EPISODE_SUMMARY - 1).trimEnd()}…` : summary;
    const r = this.db
      .prepare("INSERT OR IGNORE INTO episodes (issue_id, identifier, title, scope, summary, links, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(e.issueId, e.identifier, e.title.slice(0, 300), e.scope, cut, JSON.stringify([...new Set(e.links)].slice(0, 20)), e.closedAt);
    return Number(r.changes) > 0;
  }

  /** Past tasks, newest first, or the best matches for a query. */
  episodes(query = "", limit = 50): Episode[] {
    const w = words(query);
    if (w.length) return this.matchEpisodes(w, limit);
    return (this.db.prepare("SELECT * FROM episodes ORDER BY closed_at DESC LIMIT ?").all(limit) as unknown as EpisodeRow[]).map(toEpisode);
  }
}

const ORDER = `pinned DESC, CASE kind WHEN 'rule' THEN 0 WHEN 'fact' THEN 1 WHEN 'lesson' THEN 2 ELSE 3 END, updated_at DESC, id DESC`;

const more = (n: number) => (n ? `\n- (+${n} more left out for length: search memory to find them)` : "");

/** Without FTS: the rows with the most query words first. */
function rankByWords<T>(rows: T[], w: string[], text: (r: T) => string): T[] {
  const score = (r: T) => w.filter((x) => text(r).toLowerCase().includes(x)).length;
  return rows.map((r) => [r, score(r)] as const).sort((a, b) => b[1] - a[1]).map(([r]) => r);
}
