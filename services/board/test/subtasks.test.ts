import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Agent, Issue, Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const ME = "user-1";
const persona = (name: string) => ({ persona: { name, voice: "", avatar: name.toLowerCase() } });
const agents: Agent[] = [
  { id: "00000000-0000-0000-0000-00000000000a", name: "Assistant", status: "idle", adapterType: "codex_local", metadata: { setupKey: "pennyworth:assistant", ...persona("Alfred") } },
  { id: "00000000-0000-0000-0000-0000000000c1", name: "Engineer · Claude", status: "idle", adapterType: "claude_local", adapterConfig: {}, metadata: { setupKey: "pennyworth:engineer-claude", ...persona("Ada") } },
];
const ADA = agents[1]!.id;

describe("subtasks on the board (D-68)", () => {
  let issues: Issue[];
  let seq = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const make = (over: Partial<Issue>): Issue => ({ id: uuid(), identifier: `PEN-${seq}`, title: "Rotate secrets", description: "", status: "todo", priority: "high", assigneeUserId: null, assigneeAgentId: null, assigneeAdapterOverrides: null, labels: [], createdAt: `2026-11-16T10:00:${String(seq).padStart(2, "0")}Z`, updatedAt: "2026-11-16T10:00:00Z", ...over });
  const find = (ref: string) => issues.find((i) => i.id === ref || i.identifier === ref);
  const open = () => issues.filter((i) => !["done", "cancelled"].includes(i.status));
  const pc = {
    me: async () => ME,
    agents: async () => agents,
    labels: async () => [],
    company: async () => ({ issuePrefix: "PEN" }),
    issue: async (ref: string) => find(ref) ?? Promise.reject(new Error("404")),
    issueSummary: async (ref: string) => find(ref),
    children: async (id: string) => issues.filter((i) => i.parentId === id),
    openIssues: async () => open(),
    closedSince: async () => issues.filter((i) => ["done", "cancelled"].includes(i.status)),
    comments: async () => [],
    latestComment: async () => undefined,
    attachments: async () => [],
    liveRuns: async () => [],
    recentRuns: async () => [],
    addComment: async () => ({}),
    updateIssue: async (id: string, patch: Partial<Issue>) => Object.assign(find(id)!, patch),
    createIssue: async (body: Partial<Issue>) => {
      const i = make({ ...body, assigneeUserId: body.assigneeUserId ?? null });
      issues.push(i);
      return i;
    },
  } as unknown as Paperclip;

  const store = new Store(":memory:");
  const app = createApp({ paperclip: pc, store, log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", allowedHosts: ["localhost:3120"] });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => app.close());

  const call = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const headers: Record<string, string> = { host: "localhost:3120", ...(method === "GET" ? {} : { "content-type": "application/json", "x-pennyworth-board": "1", origin: "http://localhost:3120" }) };
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });

  let task: Issue, a1: Issue, a2: Issue;
  beforeEach(() => {
    issues = [];
    task = make({ assigneeUserId: ME });
    a1 = make({ title: "A1: retire the mnemonic", parentId: task.id, assigneeUserId: ME });
    a2 = make({ title: "A2: fix userdata bindings", parentId: task.id, assigneeUserId: ME });
    issues.push(task, a1, a2);
  });

  it("lists a task's subtasks with their crews, and folds them out of the columns", async () => {
    issues.push(make({ parentId: a1.id, assigneeAgentId: ADA }));
    const view = await call("GET", `/api/issues/${task.identifier}`);
    expect(view.json.subtasks.map((s: { identifier: string; crew: { agent: string }[] }) => [s.identifier, s.crew.map((m) => m.agent)])).toEqual([[a1.identifier, [ADA]], [a2.identifier, []]]);
    const board = await call("GET", "/api/board");
    const cards = Object.values(board.json.buckets).flat() as { identifier: string; subtasks?: unknown; crew?: { agent: string }[] }[];
    expect(cards.map((c) => c.identifier)).toEqual([task.identifier]);
    expect(cards[0]!.subtasks).toEqual({ open: 2, total: 2 });
    expect(cards[0]!.crew!.map((m) => m.agent)).toEqual([ADA]);
  });

  it("adds a subtask, but never under a subtask", async () => {
    const res = await call("POST", `/api/issues/${task.identifier}/subtasks`, { title: "A3: isolate signers" });
    expect(res.status).toBe(200);
    expect(res.json.subtasks).toHaveLength(3);
    const a3 = issues.at(-1)!;
    expect([a3.parentId, a3.assigneeUserId, a3.assigneeAgentId]).toEqual([task.id, ME, null]);
    expect((await call("POST", `/api/issues/${a1.identifier}/subtasks`, { title: "deeper" })).status).toBe(400);
  });

  it("puts one agent with the same instructions on each picked subtask", async () => {
    const res = await call("POST", `/api/issues/${task.identifier}/subtasks/agents`, { subtasks: [a1.id, a2.id], agent: ADA, instructions: "Check the live bindings and report." });
    expect(res.status).toBe(200);
    const parts = issues.filter((i) => i.assigneeAgentId === ADA);
    expect(parts.map((p) => [p.parentId, p.title, p.description])).toEqual([
      [a1.id, a1.title, "Check the live bindings and report."],
      [a2.id, a2.title, "Check the live bindings and report."],
    ]);
    const other = make({ assigneeUserId: ME });
    issues.push(other);
    expect((await call("POST", `/api/issues/${task.identifier}/subtasks/agents`, { subtasks: [other.id], agent: ADA, instructions: "x" })).status).toBe(400);
  });

  it("closes open subtasks and their crew with the task only when asked", async () => {
    const part = make({ parentId: a1.id, assigneeAgentId: ADA });
    issues.push(part);
    await call("PATCH", `/api/issues/${task.identifier}`, { status: "done" });
    expect([a1.status, a2.status, part.status]).toEqual(["todo", "todo", "todo"]);
    task.status = "todo";
    await call("PATCH", `/api/issues/${task.identifier}`, { status: "done", subtasks: "close" });
    expect([task.status, a1.status, a2.status, part.status]).toEqual(["done", "done", "done", "done"]);
  });

  it("makes a task a subtask and moves it back to the board, one level deep", async () => {
    const loose = make({ assigneeUserId: ME });
    issues.push(loose);
    expect((await call("POST", `/api/issues/${loose.identifier}/parent`, { parent: task.identifier })).status).toBe(200);
    expect(loose.parentId).toBe(task.id);
    // A task with subtasks can't become one, and nothing goes under a subtask.
    const other = make({ assigneeUserId: ME });
    issues.push(other);
    expect((await call("POST", `/api/issues/${task.identifier}/parent`, { parent: other.identifier })).status).toBe(409);
    expect((await call("POST", `/api/issues/${other.identifier}/parent`, { parent: a1.identifier })).status).toBe(400);
    expect((await call("POST", `/api/issues/${loose.identifier}/parent`, { parent: null })).status).toBe(200);
    expect(loose.parentId).toBeNull();
    expect(store.placements().get(loose.id)?.bucket).toBe("triage");
  });
});
