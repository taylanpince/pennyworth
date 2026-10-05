import type { Db } from "../db/db.js";
import { tx } from "../db/db.js";
import { newId, nowIso } from "../util/ids.js";

export type SourceType = "local_transcript" | "google_drive" | "manual";

/**
 * pending                 discovered, not yet matched
 * needs_review            waiting for the user to pick the calendar event
 * unmatched               no acceptable candidate; retried on later scans
 * matched                 associated with a meeting, awaiting extraction/publish
 * obsidian_write_pending  publish failed because the vault was unavailable; retry
 * processed               published (terminal for this revision)
 * failed                  extraction or publish failed; retryable
 * ignored                 user chose to ignore; terminal
 * superseded              a newer revision of the same file exists; terminal
 */
export type SourceStatus =
  | "pending"
  | "needs_review"
  | "unmatched"
  | "matched"
  | "obsidian_write_pending"
  | "processed"
  | "failed"
  | "ignored"
  | "superseded";

export const ACTIONABLE_STATUSES: SourceStatus[] = ["pending", "unmatched", "matched", "obsidian_write_pending", "failed"];

export interface SourceRow {
  id: string;
  source_type: SourceType;
  external_id: string;
  path: string | null;
  content_hash: string;
  size: number | null;
  revision: number;
  previous_source_id: string | null;
  created_at: string | null;
  modified_at: string | null;
  first_seen_at: string;
  last_processed_at: string | null;
  status: SourceStatus;
  status_detail: string | null;
  attempts: number;
  metadata_json: string;
}

export interface SourceMetadata {
  title_hint?: string;
  filename?: string;
  date_hint?: string;
  start_hint?: string; // UTC ISO from filename
  end_hint?: string; // UTC ISO, e.g. file mtime (transcript finished writing)
  time_basis?: "filename" | "mtime" | "provider";
  ext?: string;
  drive?: { file_id: string; mime_type?: string; web_link?: string; version?: string };
}

export interface UpsertSourceInput {
  source_type: SourceType;
  external_id: string;
  path?: string;
  content_hash: string;
  size?: number;
  created_at?: string;
  modified_at?: string;
  metadata: SourceMetadata;
}

export type UpsertResult = { source: SourceRow; created: boolean };

export class SourceStore {
  constructor(private readonly db: Db) {}

  get(id: string): SourceRow | undefined {
    return this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as SourceRow | undefined;
  }

  latestRevision(sourceType: SourceType, externalId: string): SourceRow | undefined {
    return this.db
      .prepare("SELECT * FROM sources WHERE source_type = ? AND external_id = ? ORDER BY revision DESC LIMIT 1")
      .get(sourceType, externalId) as SourceRow | undefined;
  }

  /**
   * Register a source revision. The same content hash for the same external ID is a
   * no-op. A new hash creates a new revision and supersedes older, unfinished ones.
   */
  upsert(input: UpsertSourceInput): UpsertResult {
    return tx(this.db, () => {
      const existing = this.db
        .prepare("SELECT * FROM sources WHERE source_type = ? AND external_id = ? AND content_hash = ?")
        .get(input.source_type, input.external_id, input.content_hash) as SourceRow | undefined;
      if (existing) return { source: existing, created: false };

      const prev = this.latestRevision(input.source_type, input.external_id);
      const id = newId("src");
      this.db
        .prepare(
          `INSERT INTO sources (id, source_type, external_id, path, content_hash, size, revision, previous_source_id,
             created_at, modified_at, first_seen_at, status, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          id,
          input.source_type,
          input.external_id,
          input.path ?? null,
          input.content_hash,
          input.size ?? null,
          (prev?.revision ?? 0) + 1,
          prev?.id ?? null,
          input.created_at ?? null,
          input.modified_at ?? null,
          nowIso(),
          JSON.stringify(input.metadata),
        );
      if (prev) {
        // Older revisions that never finished are superseded; processed ones stay as history.
        this.db
          .prepare(
            `UPDATE sources SET status = 'superseded', status_detail = ?
             WHERE source_type = ? AND external_id = ? AND id != ? AND status NOT IN ('processed', 'ignored', 'superseded')`,
          )
          .run(`superseded by ${id}`, input.source_type, input.external_id, id);
      }
      return { source: this.get(id)!, created: true };
    });
  }

  setStatus(id: string, status: SourceStatus, detail?: string): void {
    const processed = status === "processed" ? nowIso() : null;
    this.db
      .prepare(
        `UPDATE sources SET status = ?, status_detail = ?, last_processed_at = COALESCE(?, last_processed_at) WHERE id = ?`,
      )
      .run(status, detail ?? null, processed, id);
  }

  bumpAttempts(id: string): void {
    this.db.prepare("UPDATE sources SET attempts = attempts + 1 WHERE id = ?").run(id);
  }

  listByStatus(statuses: SourceStatus[], limit = 50): SourceRow[] {
    const placeholders = statuses.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM sources WHERE status IN (${placeholders}) ORDER BY first_seen_at ASC LIMIT ?`)
      .all(...statuses, limit) as unknown as SourceRow[];
  }

  metadata(row: SourceRow): SourceMetadata {
    return JSON.parse(row.metadata_json) as SourceMetadata;
  }
}
