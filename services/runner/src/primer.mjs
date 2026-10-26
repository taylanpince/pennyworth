// Publishing an Engineer task's document to Primer (D-44). The agent writes the document to a
// file in the workspace; after a finished run the runner publishes it through primer-mcp: a new
// document the first time, then a new version of that same document whenever the file changed.
// The agent never gets a publishing tool.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PRIMER_FILE = join(".pennyworth", "primer.md");

/** The document's title (its first `# ` heading) and content; undefined when the file is missing or empty. */
export function readDocument(workspace, fallbackTitle) {
  const path = join(workspace, PRIMER_FILE);
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, "utf8").trim();
  if (!content) return undefined;
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(content)?.[1];
  const title = (heading ?? fallbackTitle ?? "Report").replace(/[*_`]/g, "").trim().slice(0, 200);
  return { path, title, content, hash: createHash("sha256").update(content).digest("hex") };
}

/** A Primer document's ID and link from a create_document result (JSON or text with the link). */
export function documentRef(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  const url = json?.url ?? json?.documentUrl ?? /https?:\/\/[^\s"')]+\/d\/[A-Za-z0-9-]+/.exec(String(text))?.[0];
  const documentId = json?.documentId ?? json?.id ?? (url ? /\/d\/([A-Za-z0-9-]+)/.exec(url)?.[1] : undefined);
  return { url, documentId };
}

/** One tool call on primer-mcp (stateless streamable HTTP). Resolves with the result's text; rejects on errors. */
export async function primerCall({ url, token, fetchImpl = fetch }, name, args) {
  let id = 0;
  const rpc = async (method, params) => {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`primer-mcp answered ${res.status}`);
    const json = JSON.parse(text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:")).slice(5) : text);
    if (json.error) throw new Error(String(json.error.message ?? JSON.stringify(json.error)).slice(0, 300));
    return json.result;
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pennyworth-runner", version: "0.1.0" } });
  const result = await rpc("tools/call", { name, arguments: args });
  const text = (result?.content ?? []).map((c) => c.text ?? "").join("\n");
  if (result?.isError) throw new Error(text.slice(0, 300) || `${name} failed`);
  return text;
}

/**
 * Publish the workspace's document if it changed since the last publish. `record` is the task's
 * Primer state ({ documentId, url, hash }); resolves with what happened and the new record.
 */
export async function publishDocument({ endpoint, workspace, record = {}, fallbackTitle }) {
  const doc = readDocument(workspace, fallbackTitle);
  if (!doc) return { outcome: "missing", record };
  if (doc.hash === record.hash) return { outcome: "unchanged", record };
  if (record.documentId) {
    await primerCall(endpoint, "primer_add_version", { documentId: record.documentId, content: doc.content, format: "markdown" });
    return { outcome: "updated", record: { ...record, hash: doc.hash } };
  }
  const text = await primerCall(endpoint, "primer_create_document", { title: doc.title, content: doc.content, format: "markdown" });
  let ref = documentRef(text);
  if (!ref.documentId && ref.url) ref = { ...ref, ...documentRef(await primerCall(endpoint, "primer_resolve_url", { url: ref.url })) };
  // Without an ID a later change makes a new document instead of a version; the hash is kept
  // either way, so a retry never publishes the same content twice.
  return { outcome: "created", record: { ...record, documentId: ref.documentId, url: ref.url, hash: doc.hash } };
}
