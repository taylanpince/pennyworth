import type { Config } from "../config.js";
import { localParts, MINUTE, toIso } from "../util/time.js";
import { containsWord, normalizeTokens, titleSimilarity, tokensMatch } from "./text.js";
import type { CalendarEvent, MatchDecision, ScoredCandidate, SourceEvidence } from "./types.js";

export const WEIGHTS = { temporal: 50, title: 20, attendees: 15, filename: 10, link: 5 } as const;

type MatchCfg = Config["meeting_matching"];

interface Ctx {
  cfg: MatchCfg;
  tz: string;
  selfNames: string[];
  selfEmails: string[];
  stop: Set<string>;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

function temporalScore(ev: SourceEvidence, startMs: number, endMs: number, ctx: Ctx, notes: string[]): number {
  const window = Math.max(ctx.cfg.candidate_window_before_minutes, ctx.cfg.candidate_window_after_minutes);
  if (ev.dateHint) {
    // A filename date that disagrees with the event's local date rules the event out.
    const evDate = localParts(startMs, ctx.tz).date;
    if (evDate !== ev.dateHint) {
      notes.push(`date mismatch (${ev.dateHint} vs ${evDate})`);
      return 0;
    }
  }
  if (ev.startMs !== undefined) {
    const d = Math.abs(ev.startMs - startMs) / MINUTE;
    let score = d <= 5 ? 50 : d >= window ? 0 : 50 * (1 - (d - 5) / (window - 5));
    // Started inside the event (joined or began recording late): keep a solid floor.
    if (ev.startMs >= startMs && ev.startMs <= endMs - 5 * MINUTE) score = Math.max(score, 40);
    notes.push(`start Δ ${Math.round(d)} min`);
    return score;
  }
  if (ev.endMs !== undefined) {
    // Only an end hint (e.g. file mtime). Transcripts usually finish at or shortly
    // after the meeting ends; cap lower than a real start time.
    const delta = (ev.endMs - endMs) / MINUTE; // positive: finished after event end
    notes.push(`end Δ ${Math.round(delta)} min`);
    if (delta >= -5 && delta <= 25) return 45;
    if (delta > 25) return delta >= window ? 0 : 45 * (1 - (delta - 25) / (window - 25));
    // Finished before the event ended: plausible for early ends, but decays faster.
    const early = -delta - 5;
    const duration = (endMs - startMs) / MINUTE;
    if (ev.endMs < startMs) return 0; // finished before the event started
    return Math.max(0, 45 * (1 - early / Math.max(30, duration)));
  }
  if (ev.dateHint) {
    notes.push("date only");
    return 15;
  }
  return 0;
}

function nonSelfAttendees(event: CalendarEvent, ctx: Ctx): CalendarEvent["attendees"] {
  return event.attendees.filter((a) => {
    if (a.self) return false;
    if (a.email && ctx.selfEmails.includes(a.email.toLowerCase())) return false;
    if (a.name && ctx.selfNames.some((n) => n.toLowerCase() === a.name!.toLowerCase())) return false;
    return true;
  });
}

function nameTokens(a: { name?: string; email?: string }): string[] {
  const tokens = new Set<string>();
  for (const t of (a.name ?? "").toLowerCase().split(/[^a-z0-9À-ɏ]+/)) if (t.length >= 3) tokens.add(t);
  const local = (a.email ?? "").toLowerCase().split("@")[0] ?? "";
  for (const t of local.split(/[^a-z0-9]+/)) if (t.length >= 3) tokens.add(t);
  return [...tokens];
}

function attendeeScore(ev: SourceEvidence, event: CalendarEvent, ctx: Ctx, notes: string[]): number {
  const others = nonSelfAttendees(event, ctx);
  if (others.length === 0) return 0;
  const textLower = ev.text.toLowerCase();
  const people = ev.peopleHints.map((p) => p.toLowerCase());
  let hits = 0;
  const hitNames: string[] = [];
  for (const a of others) {
    const tokens = nameTokens(a);
    const hit =
      tokens.some((t) => containsWord(textLower, t)) ||
      people.some((p) => tokens.some((t) => p.split(/\s+/).some((pt) => tokensMatch(pt, t))));
    if (hit) {
      hits++;
      hitNames.push(a.name ?? a.email ?? "?");
    }
  }
  if (hits) notes.push(`people: ${hitNames.slice(0, 5).join(", ")}`);
  return WEIGHTS.attendees * Math.min(1, hits / Math.min(2, others.length));
}

function filenameScore(ev: SourceEvidence, event: CalendarEvent, eventTokens: string[], ctx: Ctx, notes: string[]): number {
  if (!ev.filenameTitle) return 0;
  const fileTokens = normalizeTokens(ev.filenameTitle, ctx.stop);
  if (fileTokens.length === 0) return 0;
  const others = nonSelfAttendees(event, ctx);
  const personHit = others.some((a) => nameTokens(a).some((t) => fileTokens.some((f) => tokensMatch(f, t))));
  if (personHit) {
    notes.push("filename names an attendee");
    return WEIGHTS.filename;
  }
  if (titleSimilarity(fileTokens, eventTokens) >= 0.5) {
    notes.push("filename resembles title");
    return WEIGHTS.filename * 0.6;
  }
  return 0;
}

function linkScore(ev: SourceEvidence, event: CalendarEvent, notes: string[]): { score: number; explicit: boolean } {
  if (ev.driveFileId && event.attachments.some((a) => a.file_id === ev.driveFileId || a.url?.includes(ev.driveFileId!))) {
    notes.push("source is attached to the event");
    return { score: WEIGHTS.link, explicit: true };
  }
  const textLower = ev.text.toLowerCase();
  const code = event.meet_link?.match(/[a-z]{3}-[a-z]{4}-[a-z]{3}/i)?.[0];
  if (code && textLower.includes(code.toLowerCase())) {
    notes.push("meeting link code found");
    return { score: WEIGHTS.link, explicit: false };
  }
  if (event.location && event.location.length >= 6 && textLower.includes(event.location.toLowerCase())) {
    notes.push("location mentioned");
    return { score: WEIGHTS.link * 0.6, explicit: false };
  }
  return { score: 0, explicit: false };
}

/**
 * Declined events stay eligible for shared meeting documents: the user still gets Gemini
 * notes for meetings he declined. A local transcript is his own recording, so a declined
 * event can't be its source.
 */
export function eligibleEvent(event: CalendarEvent, ctx: { selfEmails: string[] }, sharedDocument = false): boolean {
  if (event.all_day) return false;
  if (event.status === "cancelled") return false;
  const self = event.attendees.find((a) => a.self || (a.email && ctx.selfEmails.includes(a.email.toLowerCase())));
  if (self?.response_status === "declined" && !sharedDocument) return false;
  return true;
}

export function scoreCandidates(ev: SourceEvidence, events: CalendarEvent[], cfg: Config): ScoredCandidate[] {
  const ctx: Ctx = {
    cfg: cfg.meeting_matching,
    tz: cfg.timezone,
    selfNames: cfg.self.names,
    selfEmails: cfg.self.emails.map((e) => e.toLowerCase()),
    stop: new Set([...cfg.meeting_matching.title_stopwords, ...cfg.self.names.flatMap((n) => n.toLowerCase().split(/\s+/))]),
  };
  const hintTokens = [...ev.titleHints, ...(ev.filenameTitle ? [ev.filenameTitle] : [])].map((h) => normalizeTokens(h, ctx.stop));
  const out: ScoredCandidate[] = [];
  for (const event of events) {
    if (!eligibleEvent(event, ctx, ev.driveFileId !== undefined)) continue;
    const startMs = Date.parse(event.start);
    const endMs = Date.parse(event.end);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) continue;
    const notes: string[] = [];
    const eventTokens = normalizeTokens(event.title, ctx.stop);
    const temporal = temporalScore(ev, startMs, endMs, ctx, notes);
    const titleSim = Math.max(0, ...hintTokens.map((h) => titleSimilarity(h, eventTokens)));
    const title = WEIGHTS.title * titleSim;
    const attendees = attendeeScore(ev, event, ctx, notes);
    const filename = filenameScore(ev, event, eventTokens, ctx, notes);
    const link = linkScore(ev, event, notes);
    const components = {
      temporal: round1(temporal),
      title: round1(title),
      attendees: round1(attendees),
      filename: round1(filename),
      link: round1(link.score),
    };
    out.push({
      event_id: event.id,
      title: event.title,
      start: toIso(startMs),
      end: toIso(endMs),
      score: round1(Math.min(100, temporal + title + attendees + filename + link.score)),
      components,
      explicit_link: link.explicit,
      notes,
    });
  }
  return out.sort((a, b) => b.score - a.score || a.start.localeCompare(b.start));
}

function describe(c: ScoredCandidate, tz: string): string {
  const p = localParts(Date.parse(c.start), tz);
  const k = c.components;
  return `"${c.title}" ${p.date} ${p.time} score ${c.score} (time ${k.temporal}, title ${k.title}, people ${k.attendees}, filename ${k.filename}, link ${k.link})`;
}

export function decide(candidates: ScoredCandidate[], cfg: Config): MatchDecision {
  const m = cfg.meeting_matching;
  const [top, second] = candidates;
  if (!top) return { status: "unmatched", score: 0, candidates, explanation: "No calendar candidates in the window." };

  const explicit = candidates.filter((c) => c.explicit_link);
  if (explicit.length === 1) {
    return {
      status: "matched",
      score: explicit[0]!.score,
      chosen: explicit[0],
      candidates,
      explanation: `Explicit link: the source document is attached to ${describe(explicit[0]!, cfg.timezone)}.`,
    };
  }

  const summary = candidates.slice(0, 3).map((c) => describe(c, cfg.timezone)).join("; ");
  if (top.score < m.review_threshold && top.components.temporal < m.review_min_temporal) {
    return { status: "unmatched", score: top.score, candidates, explanation: `Best score below review threshold. ${summary}` };
  }
  const ambiguous = second !== undefined && second.score >= m.review_threshold && top.score - second.score < m.ambiguity_margin;
  if (top.score >= m.auto_match_threshold && !ambiguous) {
    return { status: "matched", score: top.score, chosen: top, candidates, explanation: `Auto-matched ${describe(top, cfg.timezone)}.` };
  }
  return {
    status: "needs_review",
    score: top.score,
    candidates,
    explanation: ambiguous ? `Ambiguous: top candidates within ${m.ambiguity_margin} points. ${summary}` : `Score in review range. ${summary}`,
  };
}
