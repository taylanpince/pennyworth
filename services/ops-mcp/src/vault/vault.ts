import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Config } from "../config.js";
import { ConflictError, UserFacingError } from "../util/errors.js";
import { sha256 } from "../util/ids.js";
import { isWithin, resolveVaultPath } from "../util/paths.js";

export interface NoteSnapshot {
  path: string; // vault-relative
  content: string;
  version: string; // sha256 of content
}

export interface Heading {
  level: number;
  text: string;
  line: number; // 0-based
}

export type AppendResult =
  | { status: "written"; version: string; attempts: number; created_heading: boolean }
  | { status: "exists" };

/** Hook for tests: runs after the pre-image is read and before the commit check. */
export type BeforeCommitHook = (absPath: string, attempt: number) => void;

const MAX_NOTE_BYTES = 5 * 1024 * 1024;

/**
 * Restricted Obsidian vault access. All writes go through this class:
 *  - paths must be inside configured write roots (symlinks resolved);
 *  - new notes are created exclusively (never overwrite);
 *  - existing notes only receive insertions, applied with an optimistic version check
 *    and an atomic rename, and verified to preserve every byte of the pre-image.
 * There is no delete, move or replace operation.
 */
export class Vault {
  beforeCommit?: BeforeCommitHook;

  constructor(private readonly cfg: Config["vault"]) {}

  get root(): string {
    return this.cfg.root;
  }

  available(): boolean {
    try {
      return statSync(this.cfg.root).isDirectory();
    } catch {
      return false;
    }
  }

  private resolveRead(rel: string): { abs: string; rel: string } {
    return resolveVaultPath(this.cfg.root, rel, this.cfg.read_roots);
  }

  private resolveWrite(rel: string): { abs: string; rel: string } {
    if (!rel.toLowerCase().endsWith(".md")) throw new UserFacingError("Only .md notes can be written", "path_rejected");
    return resolveVaultPath(this.cfg.root, rel, this.cfg.write_roots);
  }

  exists(rel: string): boolean {
    return existsSync(this.resolveRead(rel).abs);
  }

  read(rel: string): NoteSnapshot {
    const { abs, rel: normalized } = this.resolveRead(rel);
    const st = statSync(abs);
    if (!st.isFile()) throw new UserFacingError("Not a file", "not_found");
    if (st.size > MAX_NOTE_BYTES) throw new UserFacingError("Note too large", "too_large");
    const content = readFileSync(abs, "utf8");
    return { path: normalized, content, version: sha256(content) };
  }

  documentMap(rel: string): { path: string; version: string; headings: Heading[]; frontmatter: boolean } {
    const snap = this.read(rel);
    return { path: snap.path, version: snap.version, headings: parseHeadings(snap.content), frontmatter: snap.content.startsWith("---\n") };
  }

  /** Literal, case-insensitive search over note names and contents within read roots. */
  search(query: string, limit = this.cfg.max_search_results): { path: string; matches: { line: number; text: string }[] }[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) throw new UserFacingError("Query too short", "bad_request");
    const results: { path: string; matches: { line: number; text: string }[] }[] = [];
    const realRoot = realpathSync(this.cfg.root);
    for (const dir of this.cfg.read_roots) {
      const candidate = join(realRoot, dir);
      if (!existsSync(candidate)) continue;
      const absDir = realpathSync(candidate);
      if (!isWithin(realRoot, absDir)) continue;
      for (const file of walkMarkdown(absDir)) {
        if (results.length >= limit) return results;
        const rel = relative(realRoot, file).split("\\").join("/");
        const nameHit = basename(file).toLowerCase().includes(q);
        let content: string;
        try {
          if (statSync(file).size > MAX_NOTE_BYTES) continue;
          content = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        const matches: { line: number; text: string }[] = [];
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && matches.length < 3; i++) {
          if (lines[i]!.toLowerCase().includes(q)) matches.push({ line: i + 1, text: lines[i]!.slice(0, 240) });
        }
        if (nameHit || matches.length) results.push({ path: rel, matches });
      }
    }
    return results;
  }

  /** Create a new note. Fails if the file already exists. */
  createNote(rel: string, content: string): NoteSnapshot {
    const { abs, rel: normalized } = this.resolveWrite(rel);
    mkdirSync(dirname(abs), { recursive: true });
    // Re-validate after mkdir in case a directory symlink was introduced.
    const recheck = this.resolveWrite(normalized);
    if (recheck.abs !== abs) throw new UserFacingError("Path changed during creation", "path_rejected");
    const fd = openSync(abs, "wx", 0o644);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { path: normalized, content, version: sha256(content) };
  }

  /**
   * Replace a note we own, only if it is still exactly `expectedVersion`.
   * Used for canonical meeting notes the user has not edited.
   */
  replaceIfUnchanged(rel: string, expectedVersion: string, content: string): NoteSnapshot {
    const { abs, rel: normalized } = this.resolveWrite(rel);
    this.atomicCommit(abs, expectedVersion, content, 1);
    return { path: normalized, content, version: sha256(content) };
  }

  /**
   * Insert `entry` at the end of the `heading` section (level 2). The section is
   * appended at the end of the note if missing. Idempotent via `marker`.
   * On a version conflict: re-read, recompute, retry once, then throw ConflictError.
   */
  appendUnderHeading(rel: string, heading: string, entry: string, marker: string): AppendResult {
    const { abs } = this.resolveWrite(rel);
    if (!existsSync(abs)) throw new UserFacingError(`Target note does not exist: ${rel}`, "not_found");
    for (let attempt = 1; attempt <= 2; attempt++) {
      const before = readFileSync(abs, "utf8");
      if (before.includes(marker)) return { status: "exists" };
      const { content, createdHeading, insertAt, inserted } = insertUnderHeading(before, heading, entry);
      // Verify the pre-image is preserved byte-for-byte around the insertion.
      if (content.slice(0, insertAt) + content.slice(insertAt + inserted.length) !== before) {
        throw new Error("internal: insertion would alter existing content");
      }
      try {
        this.atomicCommit(abs, sha256(before), content, attempt);
        return { status: "written", version: sha256(content), attempts: attempt, created_heading: createdHeading };
      } catch (err) {
        if (err instanceof ConflictError && attempt < 2) continue;
        throw err;
      }
    }
    throw new ConflictError("unreachable");
  }

  /**
   * Apply a pure edit function to an existing note with the optimistic version check;
   * on a conflict, re-read and retry once. Returns null if the edit made no change.
   */
  editNote(rel: string, edit: (content: string) => string): NoteSnapshot | null {
    const { abs, rel: normalized } = this.resolveWrite(rel);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const before = readFileSync(abs, "utf8");
      const after = edit(before);
      if (after === before) return null;
      try {
        this.atomicCommit(abs, sha256(before), after, attempt);
        return { path: normalized, content: after, version: sha256(after) };
      } catch (err) {
        if (err instanceof ConflictError && attempt < 2) continue;
        throw err;
      }
    }
    return null;
  }

  private atomicCommit(abs: string, expectedVersion: string, content: string, attempt: number): void {
    const tmp = join(dirname(abs), `.${basename(abs)}.pennyworth-${randomBytes(6).toString("hex")}.tmp`);
    const mode = statSync(abs).mode & 0o777;
    const fd = openSync(tmp, "wx", mode);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      this.beforeCommit?.(abs, attempt);
      const current = readFileSync(abs, "utf8");
      if (sha256(current) !== expectedVersion) {
        throw new ConflictError(`Note changed while writing: ${basename(abs)}`);
      }
      renameSync(tmp, abs);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* already renamed or gone */
      }
      throw err;
    }
  }

}

export function parseHeadings(content: string): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  let inFrontmatter = content.startsWith("---\n");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (inFrontmatter) {
      if (i > 0 && line.trim() === "---") inFrontmatter = false;
      continue;
    }
    if (/^(```|~~~)/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1]!.length, text: m[2]!, line: i });
  }
  return out;
}

/** Pure insertion logic, exported for tests. */
export function insertUnderHeading(
  content: string,
  heading: string,
  entry: string,
): { content: string; createdHeading: boolean; insertAt: number; inserted: string } {
  const headings = parseHeadings(content);
  const target = headings.find((h) => h.level === 2 && h.text.trim().toLowerCase() === heading.trim().toLowerCase());
  const body = entry.replace(/\s+$/, "") + "\n";

  if (!target) {
    const sep = content.length === 0 ? "" : content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
    const inserted = `${sep}## ${heading}\n\n${body}`;
    return { content: content + inserted, createdHeading: true, insertAt: content.length, inserted };
  }

  // End of section = next heading of level <= 2, or end of file.
  const next = headings.find((h) => h.line > target.line && h.level <= 2);
  const lines = content.split("\n");
  // Character offset of the start of line `n`.
  const offsetOfLine = (n: number): number => lines.slice(0, n).reduce((acc, l) => acc + l.length + 1, 0);
  let insertAt = next ? offsetOfLine(next.line) : content.length;
  // Keep trailing blank lines of the section after our entry.
  let prefix = content.slice(0, insertAt);
  while (prefix.endsWith("\n\n")) {
    prefix = prefix.slice(0, -1);
    insertAt--;
  }
  const before = content.slice(0, insertAt);
  const lead = before.endsWith("\n") ? "\n" : "\n\n";
  const trail = next && !content.slice(insertAt).startsWith("\n") ? "\n" : "";
  const inserted = `${lead}${body}${trail}`;
  return { content: before + inserted + content.slice(insertAt), createdHeading: false, insertAt, inserted };
}

function* walkMarkdown(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkMarkdown(full);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) yield full;
  }
}
