import { spawn } from "node:child_process";
import { z } from "zod";
import type { Attachment } from "./paperclip.js";

/**
 * Files the user attaches to a task, as context for the Assistant and the Engineers (D-43).
 * Paperclip stores them; the board uploads, lists and serves them. A PDF gets a text version
 * next to it (`<name>.txt`), so every agent can read it without a PDF reader.
 */

/** Paperclip's limit (PAPERCLIP_ATTACHMENT_MAX_BYTES, 10 MB by default). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** The JSON body of an upload: the file as base64, plus a little. */
export const MAX_UPLOAD_BODY = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 4096;

export const UploadSchema = z
  .object({
    name: z.string().trim().min(1).max(300),
    type: z.string().max(200).default(""),
    data: z.string().min(1).max(MAX_UPLOAD_BODY),
  })
  .strict();

/** A file name without paths, control characters or markup, at most 200 characters. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f<>"`|*?:]/g, "").replace(/\s+/g, " ").replace(/^\.+/, "").trim();
  if (!clean) return "file";
  if (clean.length <= 200) return clean;
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : "";
  return clean.slice(0, 200 - ext.length) + ext;
}

const TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

/** The browser's type when it's a plain MIME type, else what the name says, else generic. */
export function fileType(type: string, name: string): string {
  const t = type.split(";")[0]!.trim().toLowerCase();
  if (TYPE.test(t)) return t;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return BY_EXTENSION[ext] ?? "application/octet-stream";
}

const BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
};

export const isPdf = (type: string, name: string) => type === "application/pdf" || /\.pdf$/i.test(name);

/** Decoded upload bytes, or an error message. */
export function decode(data: string): Buffer | string {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return "the file isn't base64";
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length) return "the file is empty";
  if (bytes.length > MAX_FILE_BYTES) return `the file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`;
  return bytes;
}

export interface FileView {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
  /** "me" for the user's uploads, else "agent". */
  by: "me" | "agent";
  /** The text version of another file (a PDF's), which the board doesn't list separately. */
  textOf: string | null;
}

export function fileViews(list: Attachment[], me: string): FileView[] {
  const names = new Map(list.map((a) => [a.originalFilename ?? "", a.id]));
  return list
    .map((a) => {
      const name = a.originalFilename ?? "file";
      const base = /\.pdf\.txt$/i.test(name) ? name.slice(0, -4) : "";
      return {
        id: a.id,
        name,
        type: a.contentType,
        size: a.byteSize,
        createdAt: a.createdAt,
        by: (a.createdByUserId === me ? "me" : "agent") as FileView["by"],
        textOf: (base && names.get(base)) || null,
      };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Image types a browser shows safely inline; everything else is downloaded. */
export const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** A PDF's text (pdftotext from poppler-utils), or "" when there is none or it fails. */
export function pdfText(data: Buffer, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve("");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => resolve(""));
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= 4 * 1024 * 1024) chunks.push(c);
      else child.kill("SIGKILL");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(chunks).toString("utf8").replace(/\f/g, "\n\n").trim() : "");
    });
    child.stdin.on("error", () => {});
    child.stdin.end(data);
  });
}
