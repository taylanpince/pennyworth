// Files the user attached to a task (D-43), copied into the workspace before each run so every engine
// can read them like any other file. A sub-task also gets its parent's: the Assistant splits a task
// into Engineer sub-tasks (D-24), and the files that came with the request belong to all of them.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

export const FILES_DIR = join(".pennyworth", "files");

/** A file name that is safe on disk: no paths, control characters or leading dots. */
export function diskName(name) {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f<>"`|*?:]/g, "").replace(/\s+/g, " ").replace(/^\.+/, "").trim().slice(0, 200);
  return clean || "file";
}

/**
 * The files to copy, with their names in the workspace: the task's own, then its parent's, each
 * oldest first. Names stay the same from run to run; a clash gets the file's short id.
 */
export function plan(own, parent = []) {
  const taken = new Map();
  const byAge = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));
  const out = [];
  for (const [from, list] of [["task", own], ["parent", parent]]) {
    for (const a of [...list].sort(byAge)) {
      let name = diskName(a.originalFilename);
      if (taken.has(name.toLowerCase())) {
        const ext = extname(name);
        name = `${name.slice(0, name.length - ext.length)}-${String(a.id).slice(0, 8)}${ext}`;
      }
      taken.set(name.toLowerCase(), a.id);
      out.push({ id: a.id, name, type: a.contentType, size: a.byteSize, from });
    }
  }
  return out;
}

/** Copy the task's files (and its parent's) into the workspace. Returns what's there, for the prompt. */
export async function syncFiles(pc, issue, workspace, log = () => {}) {
  const list = (id) => pc.attachments(id).catch((err) => (log("couldn't list a task's files", { issue: id, err: String(err.message ?? err).slice(0, 200) }), []));
  const files = plan(await list(issue.id), issue.parentId ? await list(issue.parentId) : []);
  if (!files.length) return [];
  const dir = join(workspace, FILES_DIR);
  mkdirSync(dir, { recursive: true });
  const out = [];
  for (const f of files) {
    const path = join(dir, f.name);
    try {
      if (!existsSync(path) || statSync(path).size !== f.size) writeFileSync(path, await pc.attachmentContent(f.id));
      out.push({ ...f, path: join(FILES_DIR, f.name) });
    } catch (err) {
      log("couldn't copy a task's file", { issue: issue.identifier, file: f.id, err: String(err.message ?? err).slice(0, 200) });
    }
  }
  return out;
}
