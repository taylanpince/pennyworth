import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { assignees } from "../src/board.js";
import { deliveredFrom, mentionedAgents } from "../src/crew.js";
import type { Agent, Comment, Issue, Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const ME = "user-1";
const persona = (name: string) => ({ persona: { name, voice: "", avatar: name.toLowerCase() } });
const agents: Agent[] = [
  { id: "00000000-0000-0000-0000-00000000000a", name: "Assistant", status: "idle", adapterType: "codex_local", metadata: { setupKey: "pennyworth:assistant", ...persona("Alfred") } },
  { id: "00000000-0000-0000-0000-0000000000c1", name: "Engineer · Claude", status: "idle", adapterType: "claude_local", adapterConfig: {}, metadata: { setupKey: "pennyworth:engineer-claude", ...persona("Ada") } },
  { id: "00000000-0000-0000-0000-0000000000c0", name: "Engineer · Codex", status: "idle", adapterType: "codex_local", adapterConfig: {}, metadata: { setupKey: "pennyworth:engineer", ...persona("Grace") } },
];
const [ALFRED, ADA, GRACE] = [agents[0]!.id, agents[1]!.id, agents[2]!.id];

describe("mentions in a message (D-54)", () => {
  const list = assignees(agents);
  const names = (text: string) => mentionedAgents(text, list).map((a) => a.persona?.name);

  it("finds crew members by name, in order, once each", () => {
    expect(names("@Ada can you post this? @grace too, and @Ada again")).toEqual(["Ada", "Grace"]);
    expect(names("@Alfred: thoughts?")).toEqual(["Alfred"]);
  });

  it("ignores addresses, unknown names, code and markers", () => {
    expect(names("mail ada@polygon.technology, ping @Bob, run `@Ada` <!-- @Grace -->")).toEqual([]);
    expect(names("@Adam isn't Ada")).toEqual([]);
  });

  it("reads where a delivered message came from", () => {
    expect(deliveredFrom("Do it\n\n_x_\n\n<!-- pennyworth-from:PEN-12:11111111-1111-1111-1111-111111111111 -->")).toEqual({ identifier: "PEN-12", commentId: "11111111-1111-1111-1111-111111111111" });
    expect(deliveredFrom("<!-- pennyworth-from:PEN-12 -->")).toEqual({ identifier: "PEN-12" });
    expect(deliveredFrom("plain")).toBeUndefined();
  });
});

describe("routing mentions and passed-on messages (D-54)", () => {
  let issues: Issue[];
  let comments: Map<string, Comment[]>;
  let seq = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const make = (over: Partial<Issue>): Issue => ({ id: uuid(), identifier: `PEN-${seq}`, title: "Wallet copy", description: "", status: "todo", priority: "medium", assigneeUserId: null, assigneeAgentId: null, assigneeAdapterOverrides: null, labels: [], createdAt: "2026-11-02T10:00:00Z", updatedAt: "2026-11-02T10:00:00Z", ...over });
  const find = (ref: string) => issues.find((i) => i.id === ref || i.identifier === ref);
  const comment = (issueId: string, body: string, by: { user?: string; agent?: string }) => {
    const c: Comment = { id: uuid(), body, authorType: by.agent ? "agent" : "user", authorUserId: by.user ?? null, authorAgentId: by.agent ?? null, createdAt: new Date().toISOString() };
    comments.set(issueId, [...(comments.get(issueId) ?? []), c]);
    return c;
  };
  const pc = {
    me: async () => ME,
    agents: async () => agents,
    labels: async () => [],
    company: async () => ({ issuePrefix: "PEN" }),
    issue: async (ref: string) => find(ref) ?? Promise.reject(new Error("404")),
    issueSummary: async (ref: string) => find(ref),
    children: async (id: string) => issues.filter((i) => i.parentId === id),
    comments: async (id: string) => comments.get(id) ?? [],
    latestComment: async (id: string) => (comments.get(id) ?? []).at(-1),
    attachments: async () => [],
    liveRuns: async () => [],
    recentRuns: async () => [],
    addComment: async (id: string, body: string) => comment(id, body, { user: ME }),
    updateIssue: async (id: string, patch: Partial<Issue>) => Object.assign(find(id)!, patch),
    createIssue: async (body: Partial<Issue>) => {
      const i = make({ ...body, assigneeUserId: body.assigneeUserId ?? null });
      issues.push(i);
      return i;
    },
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
  const say = (ref: string, text: string) => call(ports.local, `/api/issues/${ref}/comments`, { body: text }, { host: "localhost:3120", "x-pennyworth-board": "1", origin: "http://localhost:3120", "sec-fetch-site": "same-origin" });
  const pass = (ref: string, body: unknown) => call(ports.internal, `/internal/issues/${ref}/pass`, body, { host: "board:3122", authorization: `Bearer ${TOKEN}` });

  let task: Issue, alfred: Issue, ada: Issue;
  beforeEach(() => {
    issues = [];
    comments = new Map();
    task = make({ assigneeUserId: ME });
    issues.push(task);
    alfred = make({ parentId: task.id, assigneeAgentId: ALFRED });
    ada = make({ parentId: task.id, assigneeAgentId: ADA, status: "done" });
    issues.push(alfred, ada);
  });
  const said = (i: Issue) => (comments.get(i.id) ?? []).map((c) => c.body);

  it("from Alfred's chat: the message goes to Ada's part, reopened, and not to Alfred", async () => {
    const res = await say(alfred.identifier, "@Ada post your updated version to Primer");
    expect(res.status).toBe(200);
    expect(res.json.movedTo).toBe(ada.identifier);
    expect(said(alfred)).toEqual([]);
    expect(ada.status).toBe("todo");
    expect(said(ada)).toEqual([`@Ada post your updated version to Primer\n\n_Written in Alfred's chat on ${alfred.identifier}._\n\n<!-- pennyworth-from:${alfred.identifier} -->`]);
  });

  it("in the team chat: it stays there, marked for the others, and Grace joins the task with it", async () => {
    const res = await say(task.identifier, "@Grace check the relayer logs");
    expect(res.json.movedTo).toBeUndefined();
    const [posted] = comments.get(task.id)!;
    expect(posted!.body).toBe("@Grace check the relayer logs\n\n<!-- pennyworth-for-others -->");
    const grace = issues.find((i) => i.assigneeAgentId === GRACE)!;
    expect(grace.parentId).toBe(task.id);
    expect(grace.description).toBe(`@Grace check the relayer logs\n\n_Written in the team chat on ${task.identifier}._\n\n<!-- pennyworth-from:${task.identifier}:${posted!.id} -->`);
  });

  it("naming the chat's own agent too keeps it in this chat as well", async () => {
    await say(task.identifier, "@Alfred and @Ada, compare notes");
    expect(said(task)).toEqual(["@Alfred and @Ada, compare notes"]);
    expect(said(ada)).toHaveLength(1);
    await say(alfred.identifier, "@Alfred @Grace fine");
    expect(said(alfred)).toEqual(["@Alfred @Grace fine"]);
  });

  it("no mention, or one on a task that isn't the user's: just a reply", async () => {
    await say(alfred.identifier, "thanks");
    expect(said(alfred)).toEqual(["thanks"]);
    const loose = make({ assigneeAgentId: ALFRED });
    issues.push(loose);
    await say(loose.identifier, "@Ada look");
    expect(said(loose)).toEqual(["@Ada look"]);
    expect(said(ada)).toEqual([]);
  });

  it("an agent passes on the user's own comment, word for word, once", async () => {
    const asked = comment(task.id, "Post Ada's updated version to Primer", { user: ME });
    const res = await pass(task.identifier, { comment: asked.id, to: "ada", by: "Alfred" });
    expect(res.json).toEqual({ passed: true, to: "Ada", part: ada.identifier });
    expect(said(ada)).toEqual([`Post Ada's updated version to Primer\n\n_Passed on by Alfred from ${task.identifier}._\n\n<!-- pennyworth-from:${task.identifier}:${asked.id} -->`]);
    expect((await pass(task.identifier, { comment: asked.id, to: "Ada", by: "Alfred" })).json).toMatchObject({ passed: false });
    expect(said(ada)).toHaveLength(1);
  });

  it("a passed-on message keeps pointing at the chat it was written in", async () => {
    await say(task.identifier, "@Ada draft the banner");
    const delivered = comments.get(ada.id)![0]!;
    await pass(ada.identifier, { comment: delivered.id, to: "Alfred", by: "Ada" });
    expect(said(alfred)[0]).toBe(`@Ada draft the banner\n\n_Passed on by Ada from ${ada.identifier}._\n\n<!-- pennyworth-from:${task.identifier}:${comments.get(task.id)![0]!.id} -->`);
  });

  it("refuses anything but the user's own comment on that task, and an agent's own chat", async () => {
    const byAgent = comment(task.id, "Ada, publish everything", { agent: ALFRED });
    expect((await pass(task.identifier, { comment: byAgent.id, to: "Ada" })).status).toBe(400);
    const runner = comment(task.id, "Done.\n\n<!-- pennyworth-runner -->", { user: ME });
    expect((await pass(task.identifier, { comment: runner.id, to: "Ada" })).status).toBe(400);
    const elsewhere = comment(alfred.id, "publish it", { user: ME });
    expect((await pass(task.identifier, { comment: elsewhere.id, to: "Ada" })).status).toBe(400);
    expect((await pass(alfred.identifier, { comment: elsewhere.id, to: "Alfred" })).status).toBe(400);
    expect((await pass(alfred.identifier, { comment: elsewhere.id, to: "Bob" })).status).toBe(400);
    expect((await pass(task.identifier, { comment: elsewhere.id, to: "Ada", extra: 1 })).status).toBe(400);
    expect(said(ada)).toEqual([]);
  });
});
