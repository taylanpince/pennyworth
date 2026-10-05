import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { Config } from "../config.js";
import { PathRejectedError } from "../util/errors.js";
import { sha256 } from "../util/ids.js";
import { realRoots, resolveAbsoluteWithin } from "../util/paths.js";
import { toIso } from "../util/time.js";
import { parseFilename, transcriptToText } from "./parse.js";
import type { SourceRow, SourceStore } from "./store.js";

export interface ScanReport {
  registered: SourceRow[];
  unchanged: number;
  ignored: number; // new files older than ignore_before
  settling: string[]; // files still being written (basename only)
  rejected: { path: string; reason: string }[];
  missing_roots: string[];
}

const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;

export class TranscriptScanner {
  constructor(
    private readonly cfg: Config,
    private readonly store: SourceStore,
    private readonly now: () => number = Date.now,
  ) {}

  roots(): string[] {
    return realRoots(this.cfg.transcripts.roots);
  }

  scan(): ScanReport {
    const report: ScanReport = { registered: [], unchanged: 0, ignored: 0, settling: [], rejected: [], missing_roots: [] };
    const roots = this.roots();
    report.missing_roots = this.cfg.transcripts.roots.filter((r) => !existsSync(r));
    const exts = new Set(this.cfg.transcripts.extensions.map((e) => e.toLowerCase()));

    for (const root of roots) {
      for (const candidate of this.walk(root)) {
        if (!exts.has(extname(candidate).toLowerCase())) continue;
        let real: string;
        try {
          real = resolveAbsoluteWithin(candidate, roots);
        } catch (err) {
          report.rejected.push({ path: candidate, reason: err instanceof PathRejectedError ? err.message : String(err) });
          continue;
        }
        const st = statSync(real);
        if (!st.isFile()) continue;
        if (st.size > MAX_TRANSCRIPT_BYTES) {
          report.rejected.push({ path: real, reason: "file too large" });
          continue;
        }
        // Stability gate: mtime must be at least stability_seconds old.
        if (this.now() - st.mtimeMs < this.cfg.transcripts.stability_seconds * 1000) {
          report.settling.push(real);
          continue;
        }
        const content = readFileSync(real);
        // Re-stat after reading: if the file changed mid-read, treat it as settling.
        const st2 = statSync(real);
        if (st2.size !== st.size || st2.mtimeMs !== st.mtimeMs) {
          report.settling.push(real);
          continue;
        }
        const hints = parseFilename(real, this.cfg.transcripts.filename_patterns, this.cfg.timezone);
        const { source, created } = this.store.upsert({
          source_type: "local_transcript",
          external_id: real,
          path: real,
          content_hash: sha256(content),
          size: st.size,
          created_at: toIso(st.birthtimeMs || st.mtimeMs),
          modified_at: toIso(st.mtimeMs),
          metadata: {
            title_hint: hints.title,
            filename: real.split("/").pop(),
            date_hint: hints.date,
            start_hint: hints.startMs !== undefined ? toIso(hints.startMs) : undefined,
            end_hint: toIso(st.mtimeMs),
            time_basis: hints.startMs !== undefined ? "filename" : "mtime",
            ext: extname(real).toLowerCase(),
          },
        });
        const cutoff = this.cfg.transcripts.ignore_before ? Date.parse(this.cfg.transcripts.ignore_before) : NaN;
        if (created && st.mtimeMs < cutoff) {
          this.store.setStatus(source.id, "ignored", "older than transcripts.ignore_before");
          report.ignored++;
          continue;
        }
        if (created) report.registered.push(source);
        else report.unchanged++;
      }
    }
    return report;
  }

  /** Read a registered local transcript by source ID, re-validating its path. */
  readText(source: SourceRow): string {
    if (source.source_type !== "local_transcript" || !source.path) {
      throw new PathRejectedError("not a local transcript");
    }
    const real = resolveAbsoluteWithin(source.path, this.roots());
    const raw = readFileSync(real);
    if (sha256(raw) !== source.content_hash) {
      // The file changed after registration. The next scan will register a new revision.
      throw new Error("transcript changed since registration; rescan required");
    }
    return transcriptToText(raw.toString("utf8"), extname(real));
  }

  private *walk(dir: string): Generator<string> {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (this.cfg.transcripts.recursive) yield* this.walk(full);
      } else if (e.isFile() || e.isSymbolicLink()) {
        // Symlinks are yielded and validated by resolveAbsoluteWithin; directories
        // reached through symlinks are not followed.
        yield full;
      }
    }
  }
}
