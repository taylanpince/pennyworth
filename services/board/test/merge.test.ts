import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { keepMarkers } from "../src/board.js";
import { mergedDescription } from "../src/merge.js";
import type { Agent, Attachment, Comment, Issue, Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const ME = "user-1";
const persona = (name: string) => ({ persona: { name, voice: "", avatar: name.toLowerCase() } });
const agents: Agent[] = [
  { id: "00000000-0000-0000-0000-00000000000a", name: "Assistant", status: "idle", adapterType: "codex_local", metadata: { setupKey: "pennyworth:assistant", ...persona("Alfred") } },
  { id: "00000000-0000-0000-0000-0000000000c1", name: "Engineer · Claude", status: "idle", adapterType: "claude_local", adapterConfig: {}, metadata: { setupKey: "pennyworth:engineer-claude", ...persona("Ada") } },
];
const [ALFRED, ADA] = [agents[0]!.id, agents[1]!.id];

describe("the merged description", () => {
  const source = { identifier: "PEN-9", title: "Ping Peter", description: "Ask Peter about the roadmap.\n\n<!-- source:slack:pin:C1:1700000000.1 -->" };

  it("appends the duplicate word for word, and carries its source as merged-source", () => {
    const d = mergedDescription({ description: "Prepare the overview.\n\n<!-- source:meeting:abc -->" }, source);
    expect(d).toBe("Prepare the overview.\n\n## Merged from PEN-9: Ping Peter\n\nAsk Peter about the roadmap.\n\n<!-- source:meeting:abc -->\n<!-- merged-source:slack:pin:C1:1700000000.1 -->");
  });

  it("keeps sources merged earlier, once each", () => {
    const once = mergedDescription({ description: "A" }, source);
    const twice = mergedDescription({ description: once }, { identifier: "PEN-10", title: "Again", description: "<!-- merged-source:slack:pin:C1:1700000000.1 -->" });
    expect(twice.match(/merged-source:slack:pin:C1/g)).toHaveLength(1);
    expect(twice).toContain("## Merged from PEN-10: Again");
  });

  it("stays within Paperclip's limit", () => {
    const d = mergedDescription({ description: "A" }, { ...source, description: "x".repeat(70_000) });
    expect(d.length).toBeLessThanOrEqual(60_000);
    expect(d).toContain("cut short: read PEN-9");
  });

  it("edits on the board keep merged sources too", () => {
    expect(keepMarkers("a\n\n<!-- source:x:1 -->\n<!-- merged-source:y:2 -->", "b")).toBe("b\n\n<!-- source:x:1 -->\n<!-- merged-source:y:2 -->");
  });
});

describe("merging a task into another", () => {
  let issues: Issue[];
  let comments: Map<string, Comment[]>;
  let files: Attachment[];
  let seq = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const make = (over: Partial<Issue>): Issue => ({ id: uuid(), identifier: `PEN-${seq}`, title: "Task", description: "", status: "todo", priority: "medium", assigneeUserId: null, assigneeAgentId: null, assigneeAdapterOverrides: null, labels: [], createdAt: "2026-11-02T10:00:00Z", updatedAt: "2026-11-02T10:00:00Z", ...over });
  const find = (ref: string) => issues.find((i) => i.id === ref || i.identifier === ref);
  const pc = {
    me: async () => ME,
    agents: async () => agents,
    labels: async () => [],
    company: async () => ({ issuePrefix: "PEN" }),
    issue: async (ref: string) => find(ref) ?? Promise.reject(new Error("404")),
    children: async (id: string) => issues.filter((i) => i.parentId === id),
    comments: async (id: string) => comments.get(id) ?? [],
    attachments: async (id: string) => files.filter((f) => f.issueId === id),
    attachmentContent: async (id: string) => Buffer.from(`bytes of ${id}`),
    addAttachment: async (issueId: string, name: string, type: string, data: Buffer) => {
      const f = { id: uuid(), issueId, originalFilename: name, contentType: type, byteSize: data.length, createdAt: "" };
      files.push(f);
      return f;
    },
    liveRuns: async () => [],
    recentRuns: async () => [],
    addComment: async (id: string, body: string) => {
      const c = { id: uuid(), body, authorType: "user", authorUserId: ME, createdAt: "" } as Comment;
      comments.set(id, [...(comments.get(id) ?? []), c]);
      return c;
    },
    updateIssue: async (id: string, patch: Partial<Issue>) => Object.assign(find(id)!, patch),
  } as unknown as Paperclip;

  const store = new Store(":memory:");
  const TOKEN = "t".repeat(64);
  const common = { paperclip: pc, store, log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC" };
  const local = createApp({ ...common, allowedHosts: ["localhost:3120"] });
  const internal = createApp({ ...common, allowedHosts: ["board:3122"], mode: "internal", internalToken: TOKEN });
  const ports = { local: 0, internal: 0 };
  beforeAll(async () => {
    for (const [k, app] of [["local", local], ["internal", internal]] as const) {
      await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
      ports[k] = (app.address() as AddressInfo).port;
    }
  });
  afterAll(() => (local.close(), internal.close()));

  const call = (port: number, path: string, body: unknown, headers: Record<string, string>) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path, headers: { "content-type": "application/json", ...headers } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  const merge = (ref: string, into: string) => call(ports.local, `/api/issues/${ref}/merge`, { into }, { host: "localhost:3120", "x-pennyworth-board": "1", origin: "http://localhost:3120", "sec-fetch-site": "same-origin" });
  const mergeByAgent = (ref: string, into: string) => call(ports.internal, `/internal/issues/${ref}/merge`, { into }, { host: "board:3122", authorization: `Bearer ${TOKEN}` });

  let target: Issue, dup: Issue;
  beforeEach(() => {
    issues = [];
    comments = new Map();
    files = [];
    target = make({ title: "Leadership overview", description: "Prepare it.\n\n<!-- source:meeting:a -->", assigneeUserId: ME });
    dup = make({ title: "Ping Peter", description: "Ask Peter.\n\n<!-- source:slack:pin:C1:1700000000.1 -->", assigneeUserId: ME });
    issues.push(target, dup);
  });

  it("moves the text, files and the user's sub-tasks, closes the crew, and cancels the duplicate", async () => {
    files.push({ id: uuid(), issueId: dup.id, originalFilename: "notes.pdf", contentType: "application/pdf", byteSize: 3, createdAt: "" });
    const sub = make({ parentId: dup.id, assigneeUserId: ME });
    const alfred = make({ parentId: dup.id, assigneeAgentId: ALFRED });
    issues.push(sub, alfred);
    store.schedule(dup.id, "2099-01-01", "today");

    const res = await merge(dup.identifier, target.identifier.toLowerCase());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ merged: dup.identifier, into: target.identifier, files: 1 });
    expect(target.description).toContain(`## Merged from ${dup.identifier}: Ping Peter\n\nAsk Peter.`);
    expect(target.description).toContain("<!-- merged-source:slack:pin:C1:1700000000.1 -->");
    expect(files.filter((f) => f.issueId === target.id).map((f) => f.originalFilename)).toEqual(["notes.pdf"]);
    expect(sub.parentId).toBe(target.id);
    expect(alfred.status).toBe("cancelled");
    expect(dup.status).toBe("cancelled");
    expect(store.schedules().has(dup.id)).toBe(false);
    // The note on the duplicate carries the runner's marker, so it never reaches the Assistant.
    expect(comments.get(dup.id)?.map((c) => c.body)).toEqual([`Merged into ${target.identifier}.\n\n<!-- pennyworth-runner -->`]);
  });

  it("from the Assistant, an agent's part stands for its task", async () => {
    const part = make({ parentId: dup.id, assigneeAgentId: ALFRED });
    issues.push(part);
    const res = await mergeByAgent(part.identifier, target.identifier);
    expect(res.status).toBe(200);
    expect(dup.status).toBe("cancelled");
  });

  it("refuses a task with an Engineer's work on it, saying why", async () => {
    issues.push(make({ parentId: dup.id, assigneeAgentId: ADA, status: "done" }));
    const res = await merge(dup.identifier, target.identifier);
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("Ada's work");
    expect(dup.status).toBe("todo");
    expect(target.description).not.toContain("Merged from");
  });

  it("refuses itself, closed tasks, recurring ones and tasks that aren't the user's", async () => {
    expect((await merge(dup.identifier, dup.identifier)).status).toBe(400);
    target.status = "done";
    expect((await merge(dup.identifier, target.identifier)).json.error).toContain("reopen it first");
    target.status = "todo";
    const other = make({ assigneeUserId: "someone-else" });
    issues.push(other);
    expect((await merge(dup.identifier, other.identifier)).status).toBe(403);
    store.setRecurring(dup.id, { kind: "weekly", weekday: "monday", interval: 1, time: "07:00" } as never, [], "2099-01-01T07:00:00Z");
    expect((await merge(dup.identifier, target.identifier)).json.error).toContain("stop it first");
    store.stopRecurring(dup.id);
    expect(dup.status).toBe("todo");
  });
});
