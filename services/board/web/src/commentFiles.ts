import type { CommentView, FileView } from "./types.js";

/** Runner delivery receipts identify the files from that reply, including existing conversations. */
export function commentFiles(comments: CommentView[], files: FileView[]): Map<string, FileView[]> {
  const result = new Map<string, FileView[]>();
  const shown = new Set<string>();
  for (const comment of comments) {
    if (comment.author.kind !== "runner") continue;
    const receipt = comment.body.match(/^_Attached to the task: (.+)\._$/m)?.[1];
    if (!receipt) continue;
    const names = new Set([...receipt.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
    const attached = files.filter((f) => !f.textOf && !shown.has(f.id) && names.has(f.name) && Date.parse(f.createdAt) <= Date.parse(comment.createdAt));
    for (const file of attached) shown.add(file.id);
    if (attached.length) result.set(comment.id, attached);
  }
  return result;
}
