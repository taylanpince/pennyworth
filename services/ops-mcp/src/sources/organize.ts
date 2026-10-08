import { existsSync, linkSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { Config } from "../config.js";
import { isWithin, resolveAbsoluteWithin } from "../util/paths.js";
import { localParts } from "../util/time.js";
import { siblingAudio } from "./audio.js";

export interface OrganizeMeeting {
  title: string;
  start_at: string; // UTC ISO
  attendees: { name?: string; email?: string; self?: boolean }[];
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Attendees other than the user (rooms and other calendar resources excluded). */
function others(m: OrganizeMeeting, cfg: Config): OrganizeMeeting["attendees"] {
  const selfEmails = cfg.self.emails.map((e) => e.toLowerCase());
  return m.attendees.filter((a) => !a.self && !selfEmails.includes((a.email ?? "").toLowerCase()) && !/resource\.calendar\.google\.com$/i.test(a.email ?? ""));
}

export function isOneOnOne(m: OrganizeMeeting, cfg: Config): boolean {
  return others(m, cfg).length === 1 || /\b1\s*[:/-]\s*1\b|\b1on1\b/i.test(m.title);
}

/**
 * The title part of a transcript filename, in the style of rename-transcript.sh: words joined
 * by hyphens. The user's own name, "1:1" markers and parentheticals ("(weekly)") are dropped,
 * so "Taylan / Monir" becomes "Monir". Falls back to the other person of a 1:1, then "Meeting".
 */
export function transcriptTitle(m: OrganizeMeeting, cfg: Config): string {
  let t = m.title.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\b1\s*[:/-]\s*1\b|\b1on1\b/gi, " ");
  for (const name of [...cfg.self.names].sort((a, b) => b.length - a.length)) {
    t = t.replace(new RegExp(`(^|[^\\p{L}])${escapeRegex(name)}(?=$|[^\\p{L}])`, "giu"), "$1 ");
  }
  const slug = (s: string) =>
    s
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/-+$/, "");
  const fromTitle = slug(t);
  if (fromTitle) return fromTitle;
  const other = others(m, cfg);
  if (other.length === 1) {
    const who = slug(other[0]!.name ?? other[0]!.email?.split("@")[0] ?? "");
    if (who) return who;
  }
  return "Meeting";
}

export type OrganizeOutcome = { to?: string; skipped?: string };

/**
 * Rename a recorder-named transcript after its meeting ("Monir-2026-10-08.txt", 1:1s into
 * the 1-1s folder), never overwriting anything. Returns the new absolute path, or why not.
 * `relocate` records the new path before the file moves, so a crash leaves the database
 * ahead of the disk, which the scanner's move detection repairs.
 */
export function renameTranscript(cfg: Config, roots: string[], path: string, m: OrganizeMeeting, relocate: (to: string) => void, undo: () => void): OrganizeOutcome {
  const o = cfg.transcripts.organize;
  const real = resolveAbsoluteWithin(path, roots);
  const stem = basename(real, extname(real));
  if (!new RegExp(o.unnamed_pattern).test(stem)) return { skipped: "named by the user" };
  const root = roots.find((r) => isWithin(r, real))!;
  const dir = isOneOnOne(m, cfg) && o.one_on_one_dir ? join(root, o.one_on_one_dir) : dirname(real);
  if (!isWithin(root, dir)) return { skipped: "one_on_one_dir is outside the transcript root" };
  const p = localParts(Date.parse(m.start_at), cfg.timezone);
  const base = `${transcriptTitle(m, cfg)}-${p.date}`;
  const time = /(\d{2}-\d{2}-\d{2})$/.exec(stem)?.[1] ?? p.time.replace(":", "-");
  const ext = extname(real);
  const target = [`${base}${ext}`, `${base}_${time}${ext}`].map((n) => join(dir, n)).find((t) => !existsSync(t));
  if (!target) return { skipped: "a file with the new name already exists" };
  mkdirSync(dir, { recursive: true });
  relocate(target);
  try {
    // link + unlink: an atomic rename that fails instead of replacing an existing file.
    linkSync(real, target);
    unlinkSync(real);
  } catch (err) {
    if (existsSync(real) && existsSync(target) && lstatSync(target).ino === lstatSync(real).ino) unlinkSync(target);
    undo();
    throw err;
  }
  return { to: target };
}

/** Delete the audio recorded next to a transcript (same original stem). Returns its path. */
export function deleteAudio(cfg: Config, roots: string[], originalTranscriptPath: string): string | undefined {
  const audio = siblingAudio(originalTranscriptPath, cfg.transcripts.audio_extensions);
  if (!audio) return undefined;
  const real = resolveAbsoluteWithin(audio, roots);
  if (real !== audio) return undefined; // reached through a symlink: leave it alone
  unlinkSync(real);
  return real;
}
