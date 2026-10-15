import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config } from "../config.js";
import { UserFacingError } from "../util/errors.js";
import { resolveVaultPath } from "../util/paths.js";

export interface KnowledgeBaseInfo {
  name: string;
  description?: string;
  /** How to read the base, from its agent skill (SKILL.md body). */
  guide?: string;
  documents: number;
}

export interface IndexEntry {
  path: string;
  title?: string;
  status?: string;
  summary?: string;
}

export interface SearchHit {
  base: string;
  path: string;
  title?: string;
  summary?: string;
  matches: { line: number; text: string }[];
}

const MAX_DOC_BYTES = 512 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Read-only reference documentation mounted under `knowledge.root`, one folder per base (for
 * example the wallet-brain and aggbrain doc repositories). Bases are the folder's visible
 * subdirectories; reads are confined to .md files inside one base, hidden paths excluded.
 */
export class KnowledgeBases {
  constructor(private readonly cfg: Config["knowledge"]) {}

  /** Names of the mounted bases, sorted. Empty when the root is missing. */
  names(): string[] {
    if (!existsSync(this.cfg.root)) return [];
    return readdirSync(this.cfg.root, { withFileTypes: true })
      .filter((e) => NAME.test(e.name) && !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()))
      .map((e) => e.name)
      .filter((n) => {
        try {
          return statSync(join(this.cfg.root, n)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  }

  private baseDir(name: string): string {
    if (!this.names().includes(name)) {
      const known = this.names();
      throw new UserFacingError(`Unknown knowledge base "${name}"${known.length ? ` (available: ${known.join(", ")})` : " (none are mounted)"}`, "not_found");
    }
    return realpathSync(join(this.cfg.root, name));
  }

  list(): KnowledgeBaseInfo[] {
    return this.names().map((name) => {
      const dir = this.baseDir(name);
      const skill = readSkill(dir, name);
      return { name, ...skill, documents: [...walkMarkdown(dir)].length };
    });
  }

  /** The base's README plus every document's title, status and summary from its frontmatter. */
  index(name: string): { base: string; readme?: string; documents: IndexEntry[] } {
    const dir = this.baseDir(name);
    const documents: IndexEntry[] = [];
    for (const file of walkMarkdown(dir)) {
      const fm = frontmatter(readSmall(file) ?? "");
      documents.push({ path: rel(dir, file), ...(fm.title ? { title: fm.title } : {}), ...(fm.status ? { status: fm.status } : {}), ...(fm.summary ? { summary: fm.summary } : {}) });
    }
    documents.sort((a, b) => byPath(a, b));
    const readme = existsSync(join(dir, "README.md")) ? readSmall(join(dir, "README.md")) : undefined;
    return { base: name, ...(readme ? { readme } : {}), documents };
  }

  /**
   * Case-insensitive search for documents containing every word of the query (in the path or
   * the text), ranked by how often the words occur. One base, or all of them.
   */
  search(query: string, base?: string, limit = this.cfg.max_search_results): SearchHit[] {
    const terms = [...new Set(query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2))];
    if (!terms.length) throw new UserFacingError("Query too short", "bad_request");
    const bases = base ? [base] : this.names();
    const scored: (SearchHit & { score: number })[] = [];
    for (const name of bases) {
      const dir = this.baseDir(name);
      for (const file of walkMarkdown(dir)) {
        const content = readSmall(file);
        if (content === undefined) continue;
        const path = rel(dir, file);
        const hay = `${path}\n${content}`.toLowerCase();
        if (!terms.every((t) => hay.includes(t))) continue;
        const fm = frontmatter(content);
        // Capped counts, so long working notes (build plans, pasted sources) don't outrank the
        // specs; a hit in the path, title or summary counts most, and documented specs get a lift.
        const lead = `${fm.title ?? ""}\n${fm.summary ?? ""}`.toLowerCase();
        const score = terms.reduce((s, t) => s + Math.min(count(hay, t), 10) + (path.toLowerCase().includes(t) ? 20 : 0) + (lead.includes(t) ? 20 : 0), fm.summary ? 10 : 0);
        const matches: { line: number; text: string }[] = [];
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && matches.length < 3; i++) {
          const l = lines[i]!.toLowerCase();
          if (terms.some((t) => l.includes(t))) matches.push({ line: i + 1, text: lines[i]!.slice(0, 240) });
        }
        scored.push({ base: name, path, ...(fm.title ? { title: fm.title } : {}), ...(fm.summary ? { summary: fm.summary } : {}), matches, score });
      }
    }
    return scored
      .sort((a, b) => b.score - a.score || byPath(a, b))
      .slice(0, limit)
      .map(({ score: _score, ...hit }) => hit);
  }

  read(name: string, path: string): { base: string; path: string; content: string } {
    const dir = this.baseDir(name);
    if (!path.toLowerCase().endsWith(".md")) throw new UserFacingError("Only .md documents can be read", "path_rejected");
    const { abs, rel: normalized } = resolveVaultPath(dir, path, [""]);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new UserFacingError(`No document ${normalized} in ${name}`, "not_found");
    const content = readSmall(abs);
    if (content === undefined) throw new UserFacingError("Document too large", "too_large");
    return { base: name, path: normalized, content };
  }
}

function readSkill(dir: string, name: string): { description?: string; guide?: string } {
  // Agent skills ship the base's "when to use" and reading order (.agents/skills/<name>/SKILL.md).
  for (const p of [join(dir, ".agents", "skills", name, "SKILL.md"), join(dir, "SKILL.md")]) {
    const text = existsSync(p) ? readSmall(p) : undefined;
    if (!text) continue;
    const fm = frontmatter(text);
    const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    return { ...(fm.description ? { description: fm.description } : {}), ...(body ? { guide: body } : {}) };
  }
  return {};
}

function frontmatter(text: string): Record<string, string | undefined> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  try {
    const data = parseYaml(m[1]!) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return {};
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
    return { title: str(data.title), status: str(data.status), summary: str(data.summary), description: str(data.description) };
  } catch {
    return {};
  }
}

function readSmall(file: string): string | undefined {
  try {
    if (statSync(file).size > MAX_DOC_BYTES) return undefined;
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function count(hay: string, term: string): number {
  let n = 0;
  for (let i = hay.indexOf(term); i !== -1; i = hay.indexOf(term, i + term.length)) n++;
  return n;
}

function rel(dir: string, file: string): string {
  return relative(dir, file).split("\\").join("/");
}

function* walkMarkdown(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkMarkdown(full);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) yield full;
  }
}

/** Code-point order, so the index reads the same whatever the locale. */
function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
