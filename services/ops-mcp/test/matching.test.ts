import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { decide, scoreCandidates } from "../src/matching/score.js";
import type { SourceEvidence } from "../src/matching/types.js";
import { parseFilename, parseMeetDocTitle } from "../src/sources/parse.js";
import { event, people } from "./helpers.js";

const cfg = ConfigSchema.parse({
  timezone: "Europe/Madrid",
  self: { names: ["Taylan"], emails: ["taylan@example.com"] },
  transcripts: { roots: ["/x"] },
  vault: { root: "/v", read_roots: ["a"], write_roots: ["a"] },
  routing: { config_path: "/r.yaml" },
  paperclip: { base_url: "http://p:3100" },
});

const ev = (e: Partial<SourceEvidence>): SourceEvidence => ({ titleHints: [], text: "", peopleHints: [], ...e });
const at = (iso: string) => Date.parse(iso);
const run = (e: SourceEvidence, events: Parameters<typeof scoreCandidates>[1]) => decide(scoreCandidates(e, events, cfg), cfg);

const omsPrivy = event({
  id: "oms",
  title: "OMS <> Privy Integration",
  start: "2026-10-04T14:00:00+02:00",
  end: "2026-10-04T14:30:00+02:00",
  attendees: people("Alice", "Bob", "Taylan"),
});

describe("filename parsing", () => {
  it("parses whisper-style names with and without time", () => {
    const a = parseFilename("/t/Joe-Finkel-2026-08-17_22-30-01.txt", cfg.transcripts.filename_patterns, "Europe/Madrid");
    expect(a.title).toBe("Joe Finkel");
    expect(new Date(a.startMs!).toISOString()).toBe("2026-08-17T20:30:01.000Z");
    const b = parseFilename("/t/Agglayer-Roadmap-Huddle-2-2026-09-17.txt", cfg.transcripts.filename_patterns, "Europe/Madrid");
    expect(b).toEqual({ title: "Agglayer Roadmap Huddle 2", date: "2026-09-17" });
    const c = parseFilename("/t/2026-10-04_1401.md", cfg.transcripts.filename_patterns, "Europe/Madrid");
    expect(c.date).toBe("2026-10-04");
    expect(new Date(c.startMs!).toISOString()).toBe("2026-10-04T12:01:00.000Z");
  });
});

describe("Meet document titles", () => {
  it("parses transcript and Gemini note titles", () => {
    const a = parseMeetDocTitle("OMS <> Privy Integration (2026-10-04 14:00 GMT+02:00) - Transcript", "Europe/Madrid");
    expect(a.title).toBe("OMS <> Privy Integration");
    expect(new Date(a.startMs!).toISOString()).toBe("2026-10-04T12:00:00.000Z");
    const b = parseMeetDocTitle("Wallet Weekly - 2026/10/04 14:45 CEST - Notes by Gemini", "Europe/Madrid");
    expect(b.title).toBe("Wallet Weekly");
    expect(new Date(b.startMs!).toISOString()).toBe("2026-10-04T12:45:00.000Z");
    expect(parseMeetDocTitle("Random doc", "Europe/Madrid").startMs).toBeUndefined();
  });
});

describe("meeting matching", () => {
  it("exact temporal match with attendee evidence auto-matches", () => {
    const d = run(ev({ startMs: at("2026-10-04T14:03:00+02:00"), text: "Alice: hi Bob, let's talk about Privy wallets", titleHints: ["Privy wallet integration"] }), [omsPrivy]);
    expect(d.status).toBe("matched");
    expect(d.chosen?.event_id).toBe("oms");
    expect(d.score).toBeGreaterThanOrEqual(75);
  });

  it("uses the filename timestamp as the start hint", () => {
    const hints = parseFilename("/t/2026-10-04_1401.md", cfg.transcripts.filename_patterns, "Europe/Madrid");
    const scored = scoreCandidates(ev({ startMs: hints.startMs, dateHint: hints.date }), [omsPrivy], cfg);
    expect(scored[0]!.components.temporal).toBe(50);
  });

  it("title similarity separates same-time candidates", () => {
    const other = event({ id: "other", title: "Hiring sync", start: "2026-10-04T14:00:00+02:00", end: "2026-10-04T14:30:00+02:00" });
    const scored = scoreCandidates(ev({ startMs: at("2026-10-04T14:01:00+02:00"), titleHints: ["OMS Privy integration"] }), [other, omsPrivy], cfg);
    expect(scored[0]!.event_id).toBe("oms");
    expect(scored[0]!.components.title).toBe(20);
    expect(scored[1]!.components.title).toBe(0);
  });

  it("attendee evidence counts names found in the text", () => {
    const scored = scoreCandidates(ev({ startMs: at("2026-10-04T14:00:00+02:00"), text: "thanks alice. bob will follow up" }), [omsPrivy], cfg);
    expect(scored[0]!.components.attendees).toBe(15);
    const none = scoreCandidates(ev({ startMs: at("2026-10-04T14:00:00+02:00"), text: "no names here" }), [omsPrivy], cfg);
    expect(none[0]!.components.attendees).toBe(0);
  });

  it("back-to-back meetings without evidence need review", () => {
    const weekly = event({ id: "weekly", title: "Wallet Weekly", start: "2026-10-04T14:45:00+02:00", end: "2026-10-04T15:15:00+02:00", attendees: people("Carol", "Taylan") });
    const partner = event({ id: "partner", title: "Partner Wallet Call", start: "2026-10-04T15:00:00+02:00", end: "2026-10-04T15:30:00+02:00", attendees: people("Dan", "Taylan") });
    const d = run(ev({ startMs: at("2026-10-04T15:01:00+02:00"), text: "let's discuss the wallet" }), [weekly, partner]);
    expect(d.status).toBe("needs_review");
    expect(d.chosen).toBeUndefined();
    expect(d.candidates.map((c) => c.event_id)).toEqual(["partner", "weekly"]);
  });

  it("matches the correct recurring meeting instance", () => {
    const instances = ["2026-09-27", "2026-10-04", "2026-10-11"].map((day) =>
      event({ id: `series_${day.replace(/-/g, "")}T120000Z`, series_id: "series", title: "Agglayer Weekly", start: `${day}T14:00:00+02:00`, end: `${day}T15:00:00+02:00`, attendees: people("Erin", "Taylan") }),
    );
    const d = run(ev({ startMs: at("2026-10-04T14:02:00+02:00"), dateHint: "2026-10-04", filenameTitle: "Agglayer Weekly", text: "Erin presented" }), instances);
    expect(d.status).toBe("matched");
    expect(d.chosen?.event_id).toBe("series_20261004T120000Z");
  });

  it("ambiguous strong candidates go to review even above the auto threshold", () => {
    const a = event({ id: "a", title: "OMS Privy Integration", start: "2026-10-04T14:00:00+02:00", end: "2026-10-04T14:30:00+02:00", attendees: people("Alice", "Taylan") });
    const b = event({ id: "b", title: "OMS Privy Integration (internal)", start: "2026-10-04T14:00:00+02:00", end: "2026-10-04T14:30:00+02:00", attendees: people("Alice", "Taylan") });
    const d = run(ev({ startMs: at("2026-10-04T14:00:00+02:00"), titleHints: ["OMS Privy Integration"], text: "alice" }), [a, b]);
    expect(d.candidates[0]!.score).toBeGreaterThanOrEqual(75);
    expect(d.status).toBe("needs_review");
  });

  it("no candidate leaves the source unmatched", () => {
    expect(run(ev({ startMs: at("2026-10-04T14:00:00+02:00") }), []).status).toBe("unmatched");
    const far = event({ id: "far", title: "Lunch", start: "2026-10-04T19:00:00+02:00", end: "2026-10-04T20:00:00+02:00" });
    expect(run(ev({ startMs: at("2026-10-04T14:00:00+02:00") }), [far]).status).toBe("unmatched");
  });

  it("mtime-only whisper transcripts match via end time, title and attendee in filename", () => {
    const getty = event({ id: "getty", title: "Getty <> Polygon", start: "2026-09-30T16:00:00+02:00", end: "2026-09-30T16:45:00+02:00", attendees: [{ name: "Mark Getty", email: "mark@getty.example" }, { email: "taylan@example.com", self: true }] });
    const other = event({ id: "standup", title: "Team standup", start: "2026-09-30T15:00:00+02:00", end: "2026-09-30T15:15:00+02:00" });
    const d = run(ev({ endMs: at("2026-09-30T16:49:28+02:00"), dateHint: "2026-09-30", filenameTitle: "Getty" }), [getty, other]);
    expect(d.status).toBe("matched");
    expect(d.chosen?.event_id).toBe("getty");
  });

  it("ignores declined, cancelled and all-day events", () => {
    const declined = event({ ...omsPrivy, id: "declined", attendees: [{ email: "taylan@example.com", self: true, response_status: "declined" }] });
    const cancelled = event({ ...omsPrivy, id: "cancelled", status: "cancelled" });
    const allDay = event({ ...omsPrivy, id: "allday", all_day: true });
    expect(scoreCandidates(ev({ startMs: at("2026-10-04T14:00:00+02:00") }), [declined, cancelled, allDay], cfg)).toEqual([]);
  });

  it("a Drive document attached to the event is an explicit match", () => {
    const withDoc = event({ ...omsPrivy, id: "withdoc", attachments: [{ file_id: "drive123", title: "Transcript" }] });
    const sibling = event({ ...omsPrivy, id: "sibling" });
    const d = run(ev({ endMs: at("2026-10-04T14:35:00+02:00"), driveFileId: "drive123" }), [sibling, withDoc]);
    expect(d.status).toBe("matched");
    expect(d.chosen?.event_id).toBe("withdoc");
  });
});
