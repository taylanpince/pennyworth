import { basename, extname } from "node:path";
import { zonedToEpoch } from "../util/time.js";

export interface FilenameHints {
  title?: string;
  /** Epoch ms of the start time encoded in the filename, when a time was present. */
  startMs?: number;
  /** Local date (YYYY-MM-DD) from the filename, when present. */
  date?: string;
}

/** Extract title/date/time hints from a transcript filename using configured patterns. */
export function parseFilename(path: string, patterns: string[], tz: string): FilenameHints {
  const stem = basename(path, extname(path));
  for (const pattern of patterns) {
    const m = new RegExp(pattern).exec(stem);
    if (!m?.groups) continue;
    const { title, date, time } = m.groups;
    const hints: FilenameHints = {};
    if (title) hints.title = humanizeTitle(title);
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      hints.date = date;
      const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
      if (time) {
        const digits = time.replace(/[^0-9]/g, "");
        const hour = Number(digits.slice(0, 2));
        const minute = Number(digits.slice(2, 4));
        const second = digits.length >= 6 ? Number(digits.slice(4, 6)) : 0;
        if (hour < 24 && minute < 60 && second < 60) {
          hints.startMs = zonedToEpoch({ year: y, month: mo, day: d, hour, minute, second }, tz);
        }
      }
    }
    if (hints.title || hints.date) return hints;
  }
  return { title: humanizeTitle(stem) };
}

export function humanizeTitle(raw: string): string {
  return raw.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Convert a transcript file to plain text. VTT/SRT cue numbers and timestamps are
 * dropped; speaker labels and text are kept. Content is never interpreted.
 */
export function transcriptToText(raw: string, ext: string): string {
  const e = ext.toLowerCase();
  if (e !== ".vtt" && e !== ".srt") return raw;
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (e === ".vtt" && (t === "WEBVTT" || t.startsWith("NOTE") || t.startsWith("STYLE"))) continue;
    if (/^\d+$/.test(t)) continue;
    if (/-->/.test(t)) continue;
    // <v Speaker>text</v> → Speaker: text
    out.push(t.replace(/<v\s+([^>]+)>/g, "$1: ").replace(/<[^>]+>/g, ""));
  }
  return out.join("\n");
}

/**
 * Hints from Google Meet / Gemini document titles, e.g.
 *   "OMS <> Nimbus Integration (2026-10-04 14:00 GMT+02:00) - Transcript"
 *   "OMS <> Nimbus Integration - 2026/10/04 14:00 CEST - Notes by Gemini"
 */
/** UTC offsets (minutes) for timezone abbreviations Google uses in Meet/Gemini titles. */
const TZ_ABBREVIATIONS: Record<string, number> = {
  UTC: 0, GMT: 0, WET: 0, WEST: 60, BST: 60, IST: 330, CET: 60, CEST: 120, EET: 120, EEST: 180, MSK: 180,
  EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420, AKST: -540, AKDT: -480, HST: -600,
  SGT: 480, HKT: 480, JST: 540, KST: 540, AEST: 600, AEDT: 660, NZST: 720, NZDT: 780,
};

export function parseMeetDocTitle(title: string, tz: string): FilenameHints {
  const m = /^(?<title>.*?)\s*(?:\(|-\s+)(?<date>\d{4}[-/]\d{2}[-/]\d{2})\s+(?<time>\d{1,2}:\d{2})(?:\s*(?:GMT|UTC)(?<off>[+-]\d{1,2})(?::?(?<offm>\d{2}))?|\s*(?<abbr>[A-Z]{2,5}))?\)?/.exec(title);
  if (!m?.groups) return { title: title.replace(/\s*-\s*(Transcript|Notes by Gemini)\s*$/i, "").trim() || undefined };
  const date = m.groups.date!.replace(/\//g, "-");
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = m.groups.time!.split(":").map(Number) as [number, number];
  let startMs: number;
  const abbrOffset = m.groups.abbr ? TZ_ABBREVIATIONS[m.groups.abbr] : undefined;
  if (m.groups.off !== undefined) {
    const sign = m.groups.off.startsWith("-") ? -1 : 1;
    const offMin = sign * (Math.abs(Number(m.groups.off)) * 60 + Number(m.groups.offm ?? 0));
    startMs = Date.UTC(y, mo - 1, d, h, mi) - offMin * 60_000;
  } else if (abbrOffset !== undefined) {
    startMs = Date.UTC(y, mo - 1, d, h, mi) - abbrOffset * 60_000;
  } else {
    startMs = zonedToEpoch({ year: y, month: mo, day: d, hour: h, minute: mi, second: 0 }, tz);
  }
  return { title: m.groups.title!.trim() || undefined, date, startMs };
}
