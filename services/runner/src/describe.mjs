// Pull request titles and descriptions, written for the repository's reviewers. They know nothing
// about how a change was made, so nothing about Pennyworth, Paperclip, task numbers, the agents or
// this machine may appear in what we publish (PR #44 on zkevm-techdocs said "Draft opened by
// Pennyworth for Paperclip task PEN-406"). A short Codex call writes it; code checks for leaks.
import { askCodex } from "./intake.mjs";

export const PR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "body"],
  properties: { title: { type: "string" }, body: { type: "string" } },
};

const INTERNAL = /pennyworth|paperclip|\bPEN-\d+\b|\/home\/|~\/|\bworktree\b|\bopencode\b|\bopenrouter\b|claude code|\bcodex\b/i;

/** True when text mentions our tooling, task numbers or local paths. */
export const leaksInternal = (text) => INTERNAL.test(String(text ?? ""));

/** Commit messages (\x1e-separated, oldest first) without trailers from older runner versions. */
export function cleanMessages(raw) {
  return String(raw ?? "")
    .split("\x1e")
    .map((m) => m.split("\n").filter((l) => !/^\s*Paperclip task:/i.test(l)).join("\n").trim())
    .filter(Boolean);
}

/** The safe fallback: the commit messages themselves. */
export function fallbackDescription(messages) {
  const [first, ...rest] = messages;
  const bodyOf = (m) => m.split("\n").slice(1).join("\n").trim();
  if (!rest.length) return bodyOf(first ?? "") || "";
  return ["## Changes", "", ...messages.map((m) => `- ${m.split("\n")[0]}${bodyOf(m) ? `\n\n  ${bodyOf(m).replace(/\n/g, "\n  ")}` : ""}`)].join("\n");
}

export function describePrompt({ repo, base, request, messages, stat, diff, report }) {
  const fence = (label, text, max) => `<<<${label}\n${String(text ?? "").replace(/<<<|>>>/g, "‹‹‹").slice(0, max)}\n${label}>>>`;
  return `Write the title and description of a GitHub pull request for ${repo} (into ${base}), for the repository's reviewers. Answer with JSON. Do not run any tools.

Rules:
- If the request below specifies the PR title or body (for example "Title: …" and "Body: …"), use them exactly, filled in for this repository.
- Otherwise: title in the repository's commit style (usually a conventional commit subject, at most 72 characters). Body in markdown: what changed and why, in a few sentences or bullets, then "Testing" with only checks the report says were actually run. No "Summary of the run", no step-by-step story.
- The reviewers can't see the request, the report or any tool. Never mention them, or any task tracker, ticket number, agent, AI tool, local file path or machine. Don't link to local files.
- Only describe what the diff and commits show.

${fence("REQUEST", request, 24000)}

${fence("COMMITS", messages.join("\n\n---\n\n"), 4000)}

${fence("DIFFSTAT", stat, 2000)}

${fence("DIFF", diff, 15000)}

${fence("REPORT", report, 4000)}`;
}

/**
 * Title and body for a new PR. Falls back to the commit messages when the call fails or its answer
 * mentions anything internal; generated tells which one it is.
 */
export async function writePrDescription({ cfg, repo, base, request, messages, stat, diff, report, fallbackTitle }) {
  const fallback = { title: fallbackTitle, body: fallbackDescription(messages), generated: false };
  try {
    const raw = await askCodex(cfg, describePrompt({ repo, base, request, messages, stat, diff, report }), PR_SCHEMA);
    const title = String(raw?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const body = String(raw?.body ?? "").trim().slice(0, 20_000);
    if (!title || !body || leaksInternal(title) || leaksInternal(body)) return { ...fallback, rejected: Boolean(title || body) };
    return { title, body, generated: true };
  } catch {
    return fallback;
  }
}
