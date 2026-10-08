import { stringify as toYaml } from "yaml";
import { localParts } from "../util/time.js";
import { type Extraction, inline, paragraph } from "./extraction.js";

export interface MeetingInfo {
  calendar_event_id: string;
  title: string;
  start_at: string; // UTC ISO
  end_at: string;
  timezone: string; // display timezone
  attendees: string[];
  html_link?: string;
  tags?: string[];
}

export interface SourceRef {
  type: "local-transcript" | "google-drive" | "manual";
  id: string;
  label: string; // filename or document title
  link?: string;
}

export const meetingMarker = (eventId: string): string => `<!-- paperclip-meeting:${eventId} -->`;

/** Filesystem-safe note title: drops characters Obsidian or filesystems reject. */
export function safeTitle(title: string): string {
  const cleaned = title
    .replace(/<>|<|>/g, " ")
    .replace(/[\\/:*?"|#^[\]{}]/g, " ")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return (cleaned || "Untitled meeting").slice(0, 120).trim();
}

export function canonicalNotePath(meetingsRoot: string, m: MeetingInfo): string {
  const p = localParts(Date.parse(m.start_at), m.timezone);
  return `${meetingsRoot}/${p.year}/${p.month}/${p.date} ${p.compact} - ${safeTitle(m.title)}.md`;
}

/** Wikilink target for a vault path (no extension). */
export const wikiTarget = (path: string): string => path.replace(/\.md$/i, "");

const bullets = (items: string[], empty = "- None recorded"): string => (items.length ? items.map((i) => `- ${inline(i)}`).join("\n") : empty);

function decisionLines(x: Extraction): string[] {
  return x.decisions.map((d) => (d.kind === "probable" ? `(probable) ${d.text}` : d.text));
}

function actionLines(x: Extraction): string[] {
  return x.actions.map((a) => {
    const owner = a.owner ? inline(a.owner) : "Unassigned";
    const deadline = a.deadline ? ` (due: ${inline(a.deadline)})` : "";
    return `- [ ] ${owner} — ${inline(a.action)}${deadline}`;
  });
}

export function renderCanonicalNote(m: MeetingInfo, x: Extraction, sources: SourceRef[]): string {
  const p = localParts(Date.parse(m.start_at), m.timezone);
  const end = localParts(Date.parse(m.end_at), m.timezone);
  const frontmatter = {
    type: "meeting",
    ...(m.tags?.length ? { tags: m.tags } : {}),
    calendar_event_id: m.calendar_event_id,
    date: p.date,
    start: p.time,
    end: end.time,
    attendees: m.attendees,
    topics: x.topics.map(inline),
    sources: sources.map((s) => ({ type: s.type, id: s.id })),
    processed_by: "paperclip",
  };
  const actions = actionLines(x);
  const sourceLines = sources.map((s) => `- ${s.type}: ${inline(s.label)}${s.link ? ` — ${s.link}` : ""}`);
  if (m.html_link) sourceLines.push(`- calendar: ${m.html_link}`);
  return [
    "---",
    toYaml(frontmatter, { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" }).trimEnd(),
    "---",
    "",
    `# ${inline(m.title)}`,
    "",
    meetingMarker(m.calendar_event_id),
    "",
    "## Summary",
    "",
    paragraph(x.summary),
    "",
    "## Decisions",
    "",
    bullets(decisionLines(x)),
    "",
    "## Actions",
    "",
    actions.length ? actions.join("\n") : "- None recorded",
    "",
    "## Open Questions",
    "",
    bullets(x.open_questions),
    ...(x.context.length ? ["", "## Context", "", bullets(x.context)] : []),
    ...(x.people.length ? ["", "## People", "", bullets(x.people)] : []),
    "",
    "## Source",
    "",
    sourceLines.join("\n"),
    "",
  ].join("\n");
}

export function renderMeetingLogEntry(m: MeetingInfo, x: Extraction, canonicalPath: string): string {
  const p = localParts(Date.parse(m.start_at), m.timezone);
  const parts = [
    `### ${p.date} — ${inline(m.title)}`,
    meetingMarker(m.calendar_event_id),
    "",
    `**Attendees:** ${m.attendees.length ? m.attendees.map(inline).join(", ") : "—"}`,
    "",
    `**Summary:** ${inline(x.summary)}`,
  ];
  const decisions = decisionLines(x);
  if (decisions.length) parts.push("", "**Decisions**", bullets(decisions));
  const actions = actionLines(x);
  if (actions.length) parts.push("", "**Actions**", actions.join("\n"));
  if (x.open_questions.length) parts.push("", "**Open questions**", bullets(x.open_questions));
  parts.push("", `[[${wikiTarget(canonicalPath)}]]`);
  return parts.join("\n");
}
