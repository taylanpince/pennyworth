import { z } from "zod";

/** Calendar event as supplied by the agent from its read-only calendar tool. */
export const CalendarEventSchema = z.object({
  id: z.string().min(1).max(1024).describe("Event occurrence ID (for recurring events, the instance ID, not the series ID)"),
  series_id: z.string().max(1024).optional().describe("Recurring series ID (recurringEventId), if any"),
  title: z.string().max(1000).default(""),
  start: z.string().describe("Start as ISO-8601 with offset or Z"),
  end: z.string().describe("End as ISO-8601 with offset or Z"),
  timezone: z.string().max(100).optional(),
  all_day: z.boolean().optional(),
  status: z.string().max(50).optional().describe("confirmed | tentative | cancelled"),
  attendees: z
    .array(
      z.object({
        name: z.string().max(300).optional(),
        email: z.string().max(300).optional(),
        self: z.boolean().optional(),
        response_status: z.string().max(50).optional(),
      }),
    )
    .max(500)
    .default([]),
  location: z.string().max(2000).optional(),
  meet_link: z.string().max(2000).optional(),
  attachments: z
    .array(z.object({ file_id: z.string().max(500).optional(), title: z.string().max(1000).optional(), url: z.string().max(2000).optional() }))
    .max(50)
    .default([]),
  html_link: z.string().max(2000).optional(),
});
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

export const MatchHintsSchema = z
  .object({
    title_guesses: z.array(z.string().max(300)).max(10).default([]).describe("Short topic/title guesses derived from the source"),
    people: z.array(z.string().max(200)).max(50).default([]).describe("Names of people speaking or mentioned"),
  })
  .prefault({});
export type MatchHints = z.infer<typeof MatchHintsSchema>;

export interface ScoreComponents {
  temporal: number;
  title: number;
  attendees: number;
  filename: number;
  link: number;
}

export interface ScoredCandidate {
  event_id: string;
  title: string;
  start: string; // UTC ISO
  end: string;
  score: number;
  components: ScoreComponents;
  explicit_link: boolean;
  notes: string[];
}

export type MatchStatus = "matched" | "needs_review" | "unmatched";

export interface MatchDecision {
  status: MatchStatus;
  score: number;
  chosen?: ScoredCandidate;
  candidates: ScoredCandidate[];
  explanation: string;
}

/** Everything the scorer knows about a source. */
export interface SourceEvidence {
  startMs?: number; // start time hint (filename / provider)
  endMs?: number; // end time hint (file mtime / doc modified)
  dateHint?: string; // local YYYY-MM-DD
  titleHints: string[];
  filenameTitle?: string;
  text: string; // bounded prefix of source text
  driveFileId?: string;
  peopleHints: string[];
}
