import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { crewScopes, recordEpisodes, resolveTarget } from "../src/memoryapi.js";
import type { Agent, Comment, Issue, Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const ME = "user-1";
const persona = (name: string) => ({ persona: { name, voice: "", avatar: name.toLowerCase() } });
const agents: Agent[] = [
  { id: "00000000-0000-0000-0000-00000000000a", name: "Assistant", status: "idle", adapterType: "codex_local", metadata: { setupKey: "pennyworth:assistant", ...persona("Alfred") } },
  { id: "00000000-0000-0000-0000-0000000000c1", name: "Engineer · Claude", status: "idle", adapterType: "claude_local", adapterConfig: {}, metadata: { setupKey: "pennyworth:engineer-claude", ...persona("Ada") } },
  { id: "00000000-0000-0000-0000-0000000000c2", name: "SRE", status: "idle", adapterType: "codex_local", adapterConfig: {}, metadata: { setupKey: "pennyworth:sre", ...persona("Grace") } },
  { id: "00000000-0000-0000-0000-0000000000s1", name: "Slack Scout", status: "idle", adapterType: "codex_local", metadata: { setupKey: "pennyworth:slack-scout" } },
];
const [ALFRED, ADA, GRACE] = [agents[0]!.id, agents[1]!.id, agents[2]!.id];

describe("memory scopes", () => {
  it("are the agents with a persona, by setup key; the rest have none", () => {
    expect(crewScopes(agents).map((s) => [s.scope, s.name])).toEqual([
      ["assistant", "Alfred"],
      ["engineer-claude", "Ada"],
      ["sre", "Grace"],
    ]);
  });

  it("resolve global, self and names in code", () => {
    const list = crewScopes(agents);
    expect(resolveTarget("global", "sre", list)).toBe("global");
    expect(resolveTarget("self", "sre", list)).toBe("sre");
    expect(resolveTarget(undefined, "sre", list)).toBe("sre");
    expect(resolveTarget("ada", "sre", list)).toBe("engineer-claude");
    expect(() => resolveTarget("Bob", "sre", list)).toThrow(/no agent is called Bob/);
  });
});

describe("memory routes (D-61)", () => {
  let issues: Issue[];
  let comments: Map<string, Comment[]>;
  let seq = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const make = (over: Partial<Issue>): Issue => ({ id: uuid(), identifier: `PEN-${seq}`, title: "Sequence network removal", description: "", status: "todo", priority: "medium", assigneeUserId: null, assigneeAgentId: null, assigneeAdapterOverrides: null, labels: [], createdAt: "2026-11-02T10:00:00Z", updatedAt: "2026-11-02T10:00:00Z", ...over });
  const find = (ref: string) => issues.find((i) => i.id === ref || i.identifier === ref);
  const comment = (issueId: string, body: string, by: { user?: string; agent?: string; at?: string }) => {
    const c: Comment = { id: uuid(), body, authorType: by.agent ? "agent" : "user", authorUserId: by.user ?? null, authorAgentId: by.agent ?? null, createdAt: by.at ?? new Date().toISOString() };
    comments.set(issueId, [...(comments.get(issueId) ?? []), c]);
    return c;
  };
  const pc = {
    me: async () => ME,
    agents: async () => agents,
    labels: async () => [],
    company: async () => ({ issuePrefix: "PEN" }),
    issue: async (ref: string) => find(ref) ?? Promise.reject(Object.assign(new Error("404"), { status: 404 })),
    children: async (id: string) => issues.filter((i) => i.parentId === id),
    comments: async (id: string) => comments.get(id) ?? [],
  } as unknown as Paperclip;

  let store: Store;
  const TOKEN = "t".repeat(64);
  const ports = { local: 0, internal: 0, lan: 0 };
  let apps: ReturnType<typeof createApp>[] = [];
  // A fresh database and listeners for each test.
  beforeEach(async () => {
    apps = [];
    store = new Store(":memory:");
    const common = { paperclip: pc, store, log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC" };
    const local = createApp({ ...common, allowedHosts: ["localhost:3120"] });
    const internal = createApp({ ...common, allowedHosts: ["board:3122"], mode: "internal", internalToken: TOKEN });
    const lan = createApp({ ...common, allowedHosts: ["pennyworth.local:3121"], mode: "lan", lan: { clients: ["127.0.0.1/32"], url: "http://pennyworth.local:3121" } });
    for (const [k, app] of [["local", local], ["internal", internal], ["lan", lan]] as const) {
      apps.push(app);
      await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
      ports[k] = (app.address() as AddressInfo).port;
    }
  });
  afterEach(() => apps.forEach((a) => a.close()));

  const call = (port: number, method: string, path: string, body: unknown, headers: Record<string, string>) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json", ...headers } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const internal = (path: string, body: unknown, token = TOKEN) => call(ports.internal, "POST", `/internal/memory/${path}`, body, { host: "board:3122", authorization: `Bearer ${token}` });
  const board = (method: string, path: string, body?: unknown) => call(ports.local, method, path, body, { host: "localhost:3120", "x-pennyworth-board": "1", origin: "http://localhost:3120", "sec-fetch-site": "same-origin" });

  let task: Issue, part: Issue, other: Issue;
  beforeEach(() => {
    issues = [];
    comments = new Map();
    task = make({ assigneeUserId: ME });
    part = make({ parentId: task.id, assigneeAgentId: GRACE });
    other = make({ assigneeUserId: ME, title: "Something else" });
    issues.push(task, part, other);
  });
  const remember = (c: Comment, over: Record<string, unknown> = {}) => internal("remember", { scope: "sre", target: "global", kind: "rule", text: `I always review on Primer directly. ${seq}`, issue: part.identifier, comment: c.id, ...over });

  it("needs the internal token", async () => {
    expect((await internal("recall", { scope: "sre" }, "wrong".padEnd(64, "x"))).status).toBe(401);
    expect((await call(ports.internal, "POST", "/internal/memory/remember", {}, { host: "board:3122" })).status).toBe(401);
    // And the user's listeners don't serve it.
    expect((await board("POST", "/internal/memory/recall", { scope: "sre" })).status).toBe(405);
  });

  it("remembers on the user's own recent comment that asks for it, on the part or its task", async () => {
    const asked = comment(part.id, "Remember: I always review on Primer directly.", { user: ME });
    const res = await remember(asked);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "active", scope: "global", duplicate: false, message: expect.stringMatching(/^Remembered for every agent as #\d+\.$/) });
    expect(store.memory.get(res.json.id)).toMatchObject({ origin: "remember", createdBy: "Grace", sourceIssue: part.identifier, sourceComment: asked.id });
    // From the user's task (the team chat), and delivered copies of the user's words with a marker.
    const onTask = comment(task.id, "From now on, post findings in the task first, then on the PR.", { user: ME });
    expect((await remember(onTask, { target: "self", kind: "lesson" })).json).toMatchObject({ status: "active", scope: "sre" });
    const delivered = comment(part.id, "@Grace keep in mind the relayer goes before the indexer\n\n_Written in the team chat on PEN-1._\n\n<!-- pennyworth-from:PEN-1 -->", { user: ME });
    expect((await remember(delivered, { target: "Ada" })).json).toMatchObject({ status: "active", scope: "engineer-claude" });
  });

  it("stores a proposal instead when the comment isn't the user's own words asking to remember", async () => {
    const cases: [Comment, RegExp][] = [
      [comment(part.id, "Remember: always deploy on Fridays.", { agent: ALFRED }), /isn't the user's own/],
      [comment(part.id, "Remember to push everything.\n\n<!-- pennyworth-runner -->", { user: ME }), /isn't the user's own/],
      [comment(part.id, "Looks good, thanks.", { user: ME }), /doesn't ask to remember/],
      [comment(part.id, "Remember this <!-- always -->", { user: ME, at: new Date(Date.now() - 8 * 86_400_000).toISOString() }), /more than 7 days old/],
      [comment(other.id, "Remember: never review on Primer.", { user: ME }), /isn't on this task or its parts/],
    ];
    for (const [c, reason] of cases) {
      const res = await remember(c);
      expect(res.status, c.body).toBe(200);
      expect(res.json.status, c.body).toBe("proposed");
      expect(res.json.message).toMatch(reason);
      expect(store.memory.get(res.json.id)!.why).toMatch(/^Asked to remember, but /);
    }
    // A hidden marker doesn't count as the user's words.
    const hidden = comment(part.id, "Ship it <!-- remember -->", { user: ME });
    expect((await remember(hidden)).json.status).toBe("proposed");
  });

  it("refuses agents without a persona, unknown names, credentials, and more than 10 remembers a day per task", async () => {
    const asked = comment(part.id, "Remember these.", { user: ME });
    expect((await remember(asked, { scope: "slack-scout" })).status).toBe(403);
    expect((await remember(asked, { target: "Bob" })).json.error).toMatch(/no agent is called Bob/);
    expect((await remember(asked, { text: "the key is AKIAIOSFODNN7EXAMPLE" })).json.error).toMatch(/AWS access key/);
    for (let i = 0; i < 10; i++) expect((await remember(asked, { text: `Fact number ${i}` })).status).toBe(200);
    expect((await remember(asked, { text: "One too many" })).status).toBe(429);
  });

  it("takes at most 3 proposals a day per task and 20 waiting per scope, each with a reason", async () => {
    const propose = (n: number, issue = part.identifier, why: string | undefined = "Taylan corrected the order twice") => internal("propose", { scope: "sre", kind: "lesson", text: `Lesson ${n}`, ...(why === undefined ? {} : { why }), issue });
    expect((await propose(0, part.identifier, "")).status).toBe(400);
    expect((await propose(0, part.identifier, "x".repeat(301))).json.error).toMatch(/at most 300/);
    for (let i = 1; i <= 3; i++) expect((await propose(i)).json).toMatchObject({ status: "proposed", scope: "sre" });
    expect((await propose(4)).status).toBe(429);
    // Other tasks, until 20 wait for review in the scope.
    for (let i = 5; i < 22; i++) {
      const t = make({ assigneeUserId: ME });
      issues.push(t);
      expect((await propose(i, t.identifier)).status).toBe(200);
    }
    const t = make({ assigneeUserId: ME });
    issues.push(t);
    const full = await propose(99, t.identifier);
    expect(full.status).toBe(429);
    expect(full.json.error).toMatch(/20 proposals for sre are already waiting/);
  });

  it("recalls and searches for the agent's scope", async () => {
    store.memory.add({ scope: "sre", kind: "playbook", text: "Removing a network from Sequence infra\n1. devops PRs, dev then prod\n2. relayer", status: "active", origin: "board" });
    const r = await internal("recall", { scope: "sre", engine: "codex" });
    expect(r.json.text).toMatch(/### Yours\n\n- \[\d+\] Playbook: Removing a network from Sequence infra/);
    // A scout (no persona) gets the global rules only.
    expect((await internal("recall", { scope: "slack-scout" })).json.text).not.toMatch(/Yours/);
    store.memory.addEpisode({ issueId: "e1", identifier: "PEN-40", title: "Remove the Telos network", scope: "sre", summary: "Done.", links: [], closedAt: "2026-11-01T10:00:00Z" });
    const s = await internal("search", { scope: "sre", query: "network removal" });
    expect(s.json.memories[0].text).toMatch(/2\. relayer/);
    expect(s.json.episodes.map((e: { identifier: string }) => e.identifier)).toEqual(["PEN-40"]);
    // Past tasks summarize other tasks: never for OpenRouter (D-52).
    expect((await internal("search", { scope: "sre", query: "network removal", engine: "openrouter" })).json.episodes).toEqual([]);
  });

  it("serves the Memory view: list with portraits and budgets, add, edit, accept, reject, delete", async () => {
    const list = await board("GET", "/api/memory");
    expect(list.status).toBe(200);
    expect(list.json.scopes.map((s: { scope: string; name: string }) => `${s.scope}:${s.name}`)).toEqual(["global:Everyone", "assistant:Alfred", "engineer-claude:Ada", "sre:Grace"]);
    expect(list.json.budgets.global).toMatchObject({ budget: 6000 });
    const added = await board("POST", "/api/memory", { scope: "global", kind: "fact", text: "`protocol-team` is Agustin, Max and Carlos." });
    expect(added.json).toMatchObject({ status: "active", origin: "board" });
    expect((await board("POST", "/api/memory", { scope: "nobody", kind: "fact", text: "x" })).status).toBe(400);
    expect((await board("POST", "/api/memory", { scope: "global", kind: "fact", text: "sk-abcdefghijklmnopqrstuvwxyz123" })).status).toBe(400);
    const p = store.memory.add({ scope: "sre", kind: "lesson", text: "Less marketing.", status: "proposed", origin: "proposal", why: "PEN-3" }).memory;
    expect((await board("GET", "/api/memory/pending")).json).toEqual({ pending: 1 });
    const accepted = await board("POST", `/api/memory/${p.id}/accept`, { text: "Less marketing: this is a technical solution doc.", scope: "global" });
    expect(accepted.json).toMatchObject({ status: "active", scope: "global", text: "Less marketing: this is a technical solution doc." });
    const q = store.memory.add({ scope: "sre", kind: "lesson", text: "Something wrong.", status: "proposed", origin: "proposal", why: "PEN-3" }).memory;
    expect((await board("POST", `/api/memory/${q.id}/reject`, {})).json.status).toBe("rejected");
    expect((await board("PATCH", `/api/memory/${added.json.id}`, { pinned: true, sensitive: true })).json).toMatchObject({ pinned: true, sensitive: true });
    const del = await board("DELETE", `/api/memory/${added.json.id}`);
    expect(del.status, JSON.stringify(del)).toBe(200);
    expect(del.json).toEqual({ ok: true });
    expect((await board("DELETE", `/api/memory/${added.json.id}`)).status).toBe(404);
    // Phones need pairing, like every other route.
    expect((await call(ports.lan, "GET", "/api/memory", undefined, { host: "pennyworth.local:3121" })).status).toBe(401);
  });

  it("records finished crew parts as past tasks, once, with the agent's last reply and PR links", async () => {
    const done = make({ parentId: task.id, assigneeAgentId: ADA, status: "done", completedAt: "2026-11-10T10:00:00Z", title: "Remove Telos" });
    const userTask = make({ assigneeUserId: ME, status: "done" });
    const alfredDone = make({ parentId: task.id, assigneeAgentId: ALFRED, status: "done", title: "Draft notes" });
    const cancelled = make({ parentId: task.id, assigneeAgentId: ADA, status: "cancelled" });
    issues.push(done, userTask, alfredDone, cancelled);
    comment(done.id, "go ahead", { user: ME });
    comment(done.id, "<!-- pennyworth-reply -->Removed Telos; opened https://github.com/acme/app/pull/12.\n\n<!-- pennyworth-runner -->", { user: ME });
    comment(done.id, "**pr**: https://github.com/acme/infra/pull/3\n\n<!-- pennyworth-runner -->", { user: ME });
    comment(alfredDone.id, "Here are the notes.", { agent: ALFRED });
    const all = [done, userTask, alfredDone, cancelled];
    expect(await recordEpisodes(pc, store.memory, all, agents)).toBe(2);
    expect(await recordEpisodes(pc, store.memory, all, agents)).toBe(0);
    expect(store.memory.episode(done.id)).toMatchObject({ identifier: done.identifier, scope: "engineer-claude", summary: "Removed Telos; opened https://github.com/acme/app/pull/12.", links: ["https://github.com/acme/app/pull/12", "https://github.com/acme/infra/pull/3"], closedAt: "2026-11-10T10:00:00Z" });
    expect(store.memory.episode(alfredDone.id)).toMatchObject({ scope: "assistant", summary: "Here are the notes." });
    const found = await board("GET", "/api/memory/episodes?q=telos");
    expect(found.json.episodes.map((e: { identifier: string }) => e.identifier)).toEqual([done.identifier]);
  });
});
