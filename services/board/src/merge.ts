// Merging one of the user's tasks into another: the duplicate's text joins the task it's merged into,
// word for word, and the duplicate is cancelled. Pure functions; I/O is in app.ts.
import { z } from "zod";
import { displayText } from "./board.js";
import type { Issue } from "./paperclip.js";

/** The task to merge into, e.g. PEN-12. */
export const MergeSchema = z.object({ into: z.string().trim().min(1).max(64).transform((s) => (/^[a-z][a-z0-9]*-\d+$/i.test(s) ? s.toUpperCase() : s)) }).strict();

/** Hidden markers a merge carries: the task's own source, and the sources of tasks merged into it. */
export const MARKERS = /<!-- (?:merged-)?source:[^>]*-->/g;

const MAX_DESCRIPTION = 60_000;

/**
 * A merged task's source becomes `merged-source:` on the task it joins: the tasks bridge still finds it
 * by that source (no second task for the same Slack message or email), but the scouts never close the
 * task because of it, since it isn't the task's own source.
 */
export function mergedDescription(target: Pick<Issue, "description">, source: Pick<Issue, "identifier" | "title" | "description">): string {
  const own = String(target.description ?? "").match(MARKERS) ?? [];
  const carried = (String(source.description ?? "").match(MARKERS) ?? []).map((m) => m.replace(/^<!-- source:/, "<!-- merged-source:"));
  const markers = [...new Set([...own, ...carried])].join("\n");
  const head = displayText(target.description);
  const section = `## Merged from ${source.identifier}: ${source.title}`;
  const room = MAX_DESCRIPTION - head.length - section.length - markers.length - 8;
  const body = displayText(source.description);
  const text = body.length > room ? `${body.slice(0, Math.max(0, room - 40))}\n\n_(cut short: read ${source.identifier})_` : body;
  return [head, `${section}${text ? `\n\n${text}` : ""}`, markers].filter(Boolean).join("\n\n");
}
