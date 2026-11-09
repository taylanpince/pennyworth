import { readFileSync } from "node:fs";
import { z } from "zod";

/** A backup older than this gets a banner: hourly runs, with room for a laptop that slept overnight. */
export const BACKUP_STALE_MS = 26 * 3600_000;

const StatusSchema = z.object({
  state: z.enum(["ok", "failed", "missing"]),
  at: z.string(),
  lastSuccess: z.string().nullable(),
  error: z.string().optional(),
});

export interface BackupStatus {
  /** "never": scripts/backup.sh --offsite hasn't run yet (the timer isn't installed). */
  state: "ok" | "failed" | "missing" | "never";
  lastSuccess: string | null;
  error?: string;
  /** No off-machine backup in BACKUP_STALE_MS. */
  stale: boolean;
}

/** The off-machine backup's state (D-58), from the status file scripts/backup.sh --offsite writes. */
export function readBackup(file: string, now = Date.now()): BackupStatus {
  let raw: unknown;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { state: "never", lastSuccess: null, stale: true };
  }
  try {
    raw = JSON.parse(raw as string);
  } catch {
    raw = null;
  }
  const parsed = StatusSchema.safeParse(raw);
  if (!parsed.success) return { state: "failed", lastSuccess: null, error: "unreadable backup status", stale: true };
  const s = parsed.data;
  const last = s.lastSuccess ? Date.parse(s.lastSuccess) : NaN;
  return { state: s.state, lastSuccess: s.lastSuccess, ...(s.error ? { error: s.error } : {}), stale: !(now - last < BACKUP_STALE_MS) };
}
