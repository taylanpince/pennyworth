// Files the user attached to a task (D-43), copied into the workspace before each run so every engine
// can read them like any other file. A sub-task also gets its parent's: the Assistant splits a task
// into Engineer sub-tasks (D-24), and the files that came with the request belong to all of them.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

export const FILES_DIR = join(".pennyworth", "files");
/** Files an Engineer makes for the user and the other agents (D-54): attached to its part after each run. */
export const OUT_DIR = join(".pennyworth", "out");
const MAX_SHARED = 10 * 1024 * 1024; // Paperclip's limit for one file
const MAX_SHARED_FILES = 20;
const TYPES = { md: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json", yaml: "text/plain", yml: "text/plain", log: "text/plain", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

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

/**
 * Copy the task's files (and its parent's) into the workspace. Returns what's there, for the prompt.
 * `skip`: the IDs of files the Engineer shared itself (`shareOutputs`), which aren't the user's.
 */
export async function syncFiles(pc, issue, workspace, log = () => {}, skip = new Set()) {
  const list = (id) => pc.attachments(id).catch((err) => (log("couldn't list a task's files", { issue: id, err: String(err.message ?? err).slice(0, 200) }), []));
  const files = plan((await list(issue.id)).filter((a) => !skip.has(a.id)), issue.parentId ? await list(issue.parentId) : []);
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

/**
 * What the Engineer made for others to read (D-54): its Primer document (as `<title>.md`) and the files
 * in `.pennyworth/out/`, which only it could see in the workspace before. Size-limited, no subdirectories.
 */
export function outputs(workspace, primer) {
  const out = [];
  if (primer) out.push({ name: `${diskName(primer.title).replace(/\.md$/i, "")}.md`, path: primer.path });
  const dir = join(workspace, OUT_DIR);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isFile() && !name.startsWith(".")) out.push({ name: diskName(name), path });
    }
  }
  return out.slice(0, MAX_SHARED_FILES).map((f) => ({ ...f, type: TYPES[extname(f.name).slice(1).toLowerCase()] ?? "application/octet-stream" }));
}

/**
 * Attach the Engineer's outputs to its task when they changed since the last run, replacing the earlier
 * version. `shared` is the record of what's attached ({ name: { id, hash } }); resolves with the new one
 * and the names attached now.
 */
export async function shareOutputs(pc, issue, files, shared = {}, log = () => {}) {
  const next = { ...shared };
  const attached = [];
  for (const f of files) {
    const data = readFileSync(f.path);
    if (!data.length || data.length > MAX_SHARED) continue;
    const hash = createHash("sha256").update(data).digest("hex");
    if (shared[f.name]?.hash === hash) continue;
    try {
      const a = await pc.addAttachment(issue.id, f.name, f.type, data);
      if (shared[f.name]?.id) await pc.deleteAttachment(shared[f.name].id).catch((err) => log("couldn't remove an earlier version", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 200) }));
      next[f.name] = { id: a.id, hash };
      attached.push(f.name);
    } catch (err) {
      log("couldn't attach an output", { issue: issue.identifier, file: f.name, err: String(err.message ?? err).slice(0, 200) });
    }
  }
  return { shared: next, attached };
}
