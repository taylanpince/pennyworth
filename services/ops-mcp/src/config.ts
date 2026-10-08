import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const TranscriptsSchema = z.object({
  roots: z.array(z.string()).min(1),
  extensions: z.array(z.string()).default([".md", ".txt", ".vtt", ".srt"]),
  stability_seconds: z.number().int().nonnegative().default(10),
  recursive: z.boolean().default(true),
  // Regexes applied to the file's basename (without extension). Named groups:
  // title, date (YYYY-MM-DD), time (HH-MM[-SS], HHMM or HH:MM).
  filename_patterns: z
    .array(z.string())
    .default([
      "^(?<title>.+?)[-_ ](?<date>\\d{4}-\\d{2}-\\d{2})(?:[_ T](?<time>\\d{2}[-:]?\\d{2}(?:[-:]?\\d{2})?))?$",
      "^(?<date>\\d{4}-\\d{2}-\\d{2})[_ T](?<time>\\d{2}[-:]?\\d{2}(?:[-:]?\\d{2})?)(?:[-_ ](?<title>.+))?$",
    ]),
  // Files last modified before this ISO date/time are registered as ignored (no backfill).
  ignore_before: z.string().optional(),
  // Unmatched sources are retried on later scans this many times, then left for review.
  max_match_attempts: z.number().int().positive().default(3),
  // Max characters of transcript text scanned for attendee/link evidence.
  evidence_scan_chars: z.number().int().positive().default(200_000),
  // Audio recorded next to a transcript (same name, one of these extensions). Its length
  // marks when the recording ended, and it is deleted once the meeting is published.
  audio_extensions: z.array(z.string()).default([".wav"]),
  organize: z
    .object({
      // Rename recorder-named transcripts ("2026-10-08_11-01-59.txt") after the meeting they
      // matched, the way rename-transcript.sh did: "<Title>-<YYYY-MM-DD>.txt".
      rename: z.boolean().default(true),
      // Only file stems matching this regex are renamed; names the user chose are kept.
      unnamed_pattern: z.string().default("^\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}$"),
      // 1:1s (exactly one other attendee) move into this folder under the transcript root.
      one_on_one_dir: z.string().default("1-1s"),
      // Delete the recording's audio once its meeting note is written.
      delete_audio: z.boolean().default(true),
    })
    .prefault({}),
});

const VaultSchema = z.object({
  root: z.string(),
  // Vault-relative directories ops-mcp may read/search. Anything else is invisible.
  read_roots: z.array(z.string()).min(1),
  // Vault-relative directories ops-mcp may write to (canonical notes + routed targets).
  write_roots: z.array(z.string()).min(1),
  meetings_root: z.string().default("Meetings"),
  target_heading: z.string().default("Meeting Log"),
  // Frontmatter tags on every canonical meeting note (in Obsidian: tag:#type/meeting).
  meeting_tags: z.array(z.string()).default(["type/meeting"]),
  max_search_results: z.number().int().positive().default(20),
});

const MatchingSchema = z.object({
  candidate_window_before_minutes: z.number().int().positive().default(90),
  candidate_window_after_minutes: z.number().int().positive().default(90),
  auto_match_threshold: z.number().min(0).max(100).default(75),
  review_threshold: z.number().min(0).max(100).default(55),
  // If the runner-up is within this many points of the top candidate and is itself
  // at or above review_threshold, the match is ambiguous and goes to review.
  ambiguity_margin: z.number().min(0).max(100).default(10),
  // A candidate with at least this temporal score is never silently "unmatched":
  // it goes to review even if the total is below review_threshold (spec §42).
  review_min_temporal: z.number().min(0).max(50).default(40),
  // Local recordings with a known start and end: auto-match the event that covers at least
  // this share of the recording, when no other event covers recording_overlap_rival or more.
  recording_overlap_min: z.number().min(0).max(1).default(0.6),
  recording_overlap_rival: z.number().min(0).max(1).default(0.3),
  // Generic words ignored for title similarity.
  title_stopwords: z
    .array(z.string())
    .default([
      "meeting", "call", "sync", "chat", "weekly", "daily", "the", "and", "with", "for",
      "of", "a", "an", "to", "on", "re", "x", "vs", "transcript", "notes", "by", "gemini",
    ]),
});

const RoutingSchema = z.object({
  config_path: z.string(),
  // Minimum confidence for writing a Meeting Log entry without review.
  auto_write_confidence: z.number().min(0).max(1).default(0.8),
  // Minimum confidence for each target when writing to more than one note.
  multi_target_confidence: z.number().min(0).max(1).default(0.9),
});

const PaperclipSchema = z.object({
  base_url: z.string().url(),
  company_id: z.string().optional(),
  api_key_file: z.string().optional(),
  // UI base used for links inside task bodies (loopback URL as seen by the user).
  ui_base_url: z.string().url().default("http://localhost:3100"),
  labels: z
    .object({
      meeting_action: z.string().default("meeting-action"),
      needs_review: z.string().default("needs-review"),
      system_error: z.string().default("system-error"),
    })
    .prefault({}),
  // Agent that review/action tasks are assigned to (optional). Review tasks are
  // left unassigned by default so they land in the human's board view.
  action_assignee_agent_id: z.string().optional(),
  // Which meeting action items become Paperclip tasks:
  //   mine: only actions owned by you (self.names), including shared ones
  //   mine_and_unclear: also actions with no clear owner
  //   all: also other people's actions, as "waiting-on" tasks
  meeting_action_tasks: z.enum(["mine", "mine_and_unclear", "all"]).default("mine"),
  // Routine started after applying review replies, so the agent closes those tasks promptly.
  meeting_scan_routine: z.string().default("Meeting scan"),
});

export const ConfigSchema = z.object({
  timezone: z.string().default("UTC"),
  self: z
    .object({
      names: z.array(z.string()).default([]),
      emails: z.array(z.string()).default([]),
    })
    .prefault({}),
  transcripts: TranscriptsSchema,
  vault: VaultSchema,
  meeting_matching: MatchingSchema.prefault({}),
  routing: RoutingSchema,
  paperclip: PaperclipSchema,
  server: z
    .object({
      host: z.string().default("0.0.0.0"),
      port: z.number().int().positive().default(8080),
    })
    .prefault({}),
  data: z.object({ db_path: z.string().default("/data/ops-mcp/state.sqlite") }).prefault({}),
  logging: z
    .object({
      level: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
      // When false (default) source text never appears in logs.
      verbose_sources: z.boolean().default(false),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path: string): Config {
  const raw = parseYaml(readFileSync(path, "utf8"));
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid config ${path}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
