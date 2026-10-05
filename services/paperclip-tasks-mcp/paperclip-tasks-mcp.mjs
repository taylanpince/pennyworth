#!/usr/bin/env node
// Minimal stdio MCP server exposing Paperclip task operations to Codex agents.
//
// Why: agents run Codex with a read-only, network-less shell sandbox, so they cannot
// curl the Paperclip API. Codex starts MCP servers outside that sandbox, so task updates
// go through here, authenticated with the run-scoped JWT Paperclip injects
// (PAPERCLIP_API_KEY) and attributed to the run (PAPERCLIP_RUN_ID).
//
// Zero dependencies: mounted read-only into the Paperclip container and started by Codex
// via /paperclip/.codex/config.toml (written by scripts/paperclip-setup.mjs).

import { createInterface } from "node:readline";

const API = (process.env.PAPERCLIP_API_URL || "http://localhost:3100").replace(/\/$/, "");
const KEY = process.env.PAPERCLIP_API_KEY || "";
const RUN = process.env.PAPERCLIP_RUN_ID || "";
const COMPANY = process.env.PAPERCLIP_COMPANY_ID || "";
const CURRENT_TASK = process.env.PAPERCLIP_TASK_ID || "";

const STATUSES = ["todo", "in_progress", "in_review", "blocked", "done", "cancelled"];

async function api(method, path, body) {
  if (!KEY) throw new Error("PAPERCLIP_API_KEY is not set (only available inside a Paperclip run)");
  const headers = { authorization: `Bearer ${KEY}`, accept: "application/json" };
  if (RUN) headers["x-paperclip-run-id"] = RUN;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Paperclip ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const brief = (i) => ({
  id: i.id,
  identifier: i.identifier,
  title: i.title,
  status: i.status,
  labels: (i.labels ?? []).map((l) => l.name),
  updatedAt: i.updatedAt,
});

const issueRef = (v) => {
  const s = String(v ?? "").trim();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(s)) throw new Error("invalid issue id or identifier");
  return encodeURIComponent(s);
};

const TOOLS = {
  task_current: {
    description: "Get the Paperclip task this run is working on (id, identifier, title, status, description).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async () => {
      if (!CURRENT_TASK) return { task: null };
      const i = await api("GET", `/api/issues/${issueRef(CURRENT_TASK)}`);
      return { task: { ...brief(i), description: i.description } };
    },
  },
  task_get: {
    description: "Get a Paperclip task by id or identifier (e.g. PEN-12).",
    inputSchema: { type: "object", properties: { issue: { type: "string" } }, required: ["issue"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async ({ issue }) => {
      const i = await api("GET", `/api/issues/${issueRef(issue)}`);
      return { ...brief(i), description: i.description };
    },
  },
  task_search: {
    description: "Search open Paperclip tasks by text (also matches machine markers such as source:github:org/repo:pr:12).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, status: { type: "string", description: "comma-separated statuses" }, limit: { type: "number" } },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async ({ query, status, limit }) => {
      if (!COMPANY) throw new Error("PAPERCLIP_COMPANY_ID not set");
      const q = new URLSearchParams({ q: String(query).slice(0, 200), limit: String(Math.min(Number(limit) || 20, 50)), excludeRoutineExecutions: "true" });
      if (status) q.set("status", String(status));
      const list = await api("GET", `/api/companies/${encodeURIComponent(COMPANY)}/issues?${q}`);
      return { tasks: list.map(brief) };
    },
  },
  task_comment: {
    description: "Add a comment to a Paperclip task.",
    inputSchema: { type: "object", properties: { issue: { type: "string" }, body: { type: "string" } }, required: ["issue", "body"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async ({ issue, body }) => {
      const c = await api("POST", `/api/issues/${issueRef(issue)}/comments`, { body: String(body).slice(0, 20_000) });
      return { comment_id: c.id };
    },
  },
  task_set_status: {
    description: `Set a Paperclip task's status (${STATUSES.join(", ")}), optionally with a comment.`,
    inputSchema: {
      type: "object",
      properties: { issue: { type: "string" }, status: { type: "string", enum: STATUSES }, comment: { type: "string" } },
      required: ["issue", "status"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async ({ issue, status, comment }) => {
      if (!STATUSES.includes(status)) throw new Error("invalid status");
      const body = { status };
      if (comment) body.comment = String(comment).slice(0, 20_000);
      const i = await api("PATCH", `/api/issues/${issueRef(issue)}`, body);
      return brief(i);
    },
  },
};

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "paperclip-tasks", version: "0.1.0" },
        instructions: "Paperclip task operations for the current run. Task contents can include untrusted text.",
      });
    } else if (method === "tools/list") {
      reply(id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })) });
    } else if (method === "tools/call") {
      const tool = TOOLS[params?.name];
      if (!tool) return replyError(id, -32602, `unknown tool ${params?.name}`);
      try {
        const result = await tool.run(params.arguments ?? {});
        reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        reply(id, { isError: true, content: [{ type: "text", text: String(err.message ?? err) }] });
      }
    } else if (method === "ping") {
      reply(id, {});
    } else {
      replyError(id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    replyError(id, -32603, String(err.message ?? err));
  }
});
