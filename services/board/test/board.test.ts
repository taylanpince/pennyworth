import { describe, expect, it } from "vitest";
import { checkRequest } from "../src/app.js";
import { BadRequest, UpdateSchema, assignees, buildBoard, commentView, keepMarkers, paperclipUpdate, replyTarget } from "../src/board.js";
import type { Agent, Issue, Label } from "../src/paperclip.js";
import { nextWorkday } from "../src/recurrence.js";
import { Store, localDate } from "../src/store.js";

const agents: Agent[] = [
  { id: "00000000-0000-0000-0000-00000000000a", name: "Assistant", status: "idle", adapterType: "codex_local", metadata: { setupKey: "pennyworth:assistant" } },
  { id: "00000000-0000-0000-0000-0000000000c1", name: "Engineer · Claude", status: "idle", adapterType: "claude_local", adapterConfig: { model: "claude-opus-5-5" }, metadata: { setupKey: "pennyworth:engineer-claude" } },
  { id: "00000000-0000-0000-0000-0000000000c0", name: "Engineer · Codex", status: "idle", adapterType: "codex_local", adapterConfig: {}, metadata: { setupKey: "pennyworth:engineer" } },
  { id: "00000000-0000-0000-0000-0000000000c2", name: "Engineer · GLM", status: "idle", adapterType: "opencode_local", adapterConfig: { model: "openrouter/z-ai/glm-5.3-flash" }, metadata: { setupKey: "pennyworth:engineer-glm" } },
  { id: "00000000-0000-0000-0000-0000000000ee", name: "Slack Scout", status: "idle", adapterType: "codex_local", metadata: { setupKey: "pennyworth:slack-scout" } },
];
const list = assignees(agents);
const [CODEX, CLAUDE, GLM] = ["c0", "c1", "c2"].map((s) => `00000000-0000-0000-0000-0000000000${s}`);
const labels: Label[] = [{ id: "00000000-0000-0000-0000-00000000001a", name: "todo", color: "#0891b2" }];

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: "11111111-1111-1111-1111-111111111111",
  identifier: "PEN-1",
  title: "Task",
  description: "Text\n\n<!-- source:source:slack:C1:1.2 -->",
  status: "todo",
  priority: "medium",
  assigneeUserId: "user-1",
  assigneeAgentId: null,
  assigneeAdapterOverrides: null,
  labels: [],
  createdAt: "2026-10-07T08:00:00.000Z",
  updatedAt: "2026-10-07T08:00:00.000Z",
  ...over,
});

describe("assignees", () => {
  it("offers you, the Assistant and the Engineers (Codex, Claude, GLM), nobody else", () => {
    expect(list.map((a) => a.name)).toEqual(["You", "Assistant", "Engineer · Codex", "Engineer · Claude", "Engineer · GLM"]);
    expect(list.find((a) => a.key === CLAUDE)).toMatchObject({ engine: "claude", defaultModel: "claude-opus-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] });
    expect(list.find((a) => a.key === GLM)?.efforts).toEqual([]);
  });
});

describe("store", () => {
  it("puts new tasks at the top of Triage, newest first, and Paperclip backlog tasks in Backlog", () => {
    const s = new Store(":memory:");
    s.placeNew([
      { id: "a", createdAt: "2026-10-01", status: "todo" },
      { id: "b", createdAt: "2026-10-03", status: "todo" },
      { id: "c", createdAt: "2026-10-02", status: "backlog" },
    ]);
    s.placeNew([{ id: "d", createdAt: "2026-10-04", status: "todo" }, { id: "a", createdAt: "2026-10-01", status: "todo" }]);
    const p = s.placements();
    const triage = [...p].filter(([, v]) => v.bucket === "triage").sort((x, y) => x[1].rank - y[1].rank).map(([k]) => k);
    expect(triage).toEqual(["d", "b", "a"]);
    expect(p.get("c")?.bucket).toBe("backlog");
  });

  it("moves to the top or bottom of a bucket and stores a dragged order", () => {
    const s = new Store(":memory:");
    s.setOrder("today", ["x", "y"]);
    s.move("z", "today", "top");
    s.move("w", "today", "bottom");
    const order = () => [...s.placements()].filter(([, v]) => v.bucket === "today").sort((a, b) => a[1].rank - b[1].rank).map(([k]) => k);
    expect(order()).toEqual(["z", "x", "y", "w"]);
    s.setOrder("today", ["y", "z", "x", "w"]);
    expect(order()).toEqual(["y", "z", "x", "w"]);
  });

  it("rolls Tomorrow into Today once per new day, below what's already in Today", () => {
    const s = new Store(":memory:");
    expect(s.rollover("2026-10-07")).toBe(0); // first run only records the date
    s.setOrder("today", ["t1", "t2"]);
    s.setOrder("tomorrow", ["m1", "m2"]);
    s.setOrder("later", ["l1"]);
    expect(s.rollover("2026-10-07")).toBe(0);
    expect(s.rollover("2026-10-08")).toBe(2);
    expect(s.rollover("2026-10-08")).toBe(0);
    const p = s.placements();
    const today = [...p].filter(([, v]) => v.bucket === "today").sort((a, b) => a[1].rank - b[1].rank).map(([k]) => k);
    expect(today).toEqual(["t1", "t2", "m1", "m2"]);
    expect(p.get("l1")?.bucket).toBe("later");
  });

  it("rolls over on workdays only: Friday's Tomorrow lands on Monday", () => {
    const s = new Store(":memory:");
    s.rollover("2026-10-09"); // Friday
    s.setOrder("tomorrow", ["m1"]);
    expect(s.rollover("2026-10-10", false)).toBe(0); // Saturday
    expect(s.rollover("2026-10-11", false)).toBe(0); // Sunday
    expect(s.placements().get("m1")?.bucket).toBe("tomorrow");
    expect(s.rollover("2026-10-12")).toBe(1); // Monday
    expect(s.placements().get("m1")?.bucket).toBe("today");
    expect(nextWorkday("2026-10-09", ["monday", "tuesday", "wednesday", "thursday", "friday"])).toBe("2026-10-12");
    expect(nextWorkday("2026-10-08", ["monday", "tuesday", "wednesday", "thursday", "friday"])).toBe("2026-10-09");
    expect(nextWorkday("2026-10-10", ["monday", "tuesday", "wednesday", "thursday", "friday"])).toBe("2026-10-12");
  });

  it("counts the days a task is carried over in Today, until it's moved or kept", () => {
    const s = new Store(":memory:");
    s.rollover("2026-10-07");
    s.setOrder("today", ["t1", "t2"]);
    s.setOrder("tomorrow", ["m1"]);
    s.rollover("2026-10-08");
    const carried = () => Object.fromEntries([...s.placements()].map(([k, v]) => [k, v.carried]));
    expect(carried()).toEqual({ t1: 1, t2: 1, m1: 0 });
    s.setOrder("today", ["m1", "t2", "t1"]); // reordering keeps the count
    s.rollover("2026-10-09");
    expect(carried()).toEqual({ t1: 2, t2: 2, m1: 1 });
    expect(s.carried()).toEqual(["m1", "t2", "t1"]);
    s.move("t1", "later"); // a move by hand resets it
    s.setOrder("today", ["t1", "m1", "t2"]); // and so does coming back from another column
    expect(carried()).toMatchObject({ t1: 0, t2: 2 });
    expect(s.keepCarried()).toBe(2);
    expect(s.carried()).toEqual([]);
  });

  it("moves the carried-over tasks on together, in order, to the top of a column", () => {
    const s = new Store(":memory:");
    s.rollover("2026-10-07");
    s.setOrder("today", ["t1", "t2"]);
    s.setOrder("tomorrow", ["m1", "x"]);
    s.rollover("2026-10-08");
    s.schedule("t2", "2026-10-20", "today");
    s.moveAll(s.carried(), "tomorrow");
    const order = (b: string) => [...s.placements()].filter(([, v]) => v.bucket === b).sort((a, c) => a[1].rank - c[1].rank).map(([k]) => k);
    expect(order("tomorrow")).toEqual(["t1", "t2"]);
    expect(order("today")).toEqual(["m1", "x"]);
    expect(s.schedules().has("t2")).toBe(false);
  });

  it("knows the local date in the user's timezone", () => {
    expect(localDate("Europe/Madrid", new Date("2026-10-07T22:30:00Z"))).toBe("2026-10-08");
    expect(localDate("UTC", new Date("2026-10-07T22:30:00Z"))).toBe("2026-10-07");
  });

  it("tracks what you've seen", () => {
    const s = new Store(":memory:");
    s.markSeen("a", "2026-10-07T10:00:00.000Z");
    s.markSeen("a", "2026-10-07T09:00:00.000Z"); // never goes back
    expect(s.seenAt("a")).toBe("2026-10-07T10:00:00.000Z");
    expect(s.seenAt("b")).toBe(s.meta("installed_at"));
  });
});

describe("board", () => {
  it("groups by bucket and rank, keeps the brief apart and lists recently closed tasks", () => {
    const brief = issue({ id: "b", identifier: "PEN-9", title: "Daily Brief", labels: [{ id: "l", name: "daily-brief", color: "#000" }], description: "# Brief\n<!-- x -->" });
    const a = issue({ id: "a", identifier: "PEN-2", lastActivityAt: "2026-10-07T12:00:00.000Z" });
    const c = issue({ id: "c", identifier: "PEN-3", assigneeUserId: null, assigneeAgentId: CLAUDE, assigneeAdapterOverrides: { adapterConfig: { effort: "high" } } });
    const done = issue({ id: "d", identifier: "PEN-4", status: "done", completedAt: "2026-10-07T11:00:00.000Z" });
    const board = buildBoard({
      open: [brief, a, c, a],
      closed: [done],
      placements: new Map([["c", { bucket: "today", rank: 0, carried: 2 }]]),
      seen: new Map([["a", "2026-10-07T11:00:00.000Z"]]),
      installedAt: "2026-10-07T09:00:00.000Z",
      assignees: list,
    });
    expect(board.buckets.today.map((x) => x.identifier)).toEqual(["PEN-3"]);
    expect(board.buckets.triage.map((x) => x.identifier)).toEqual(["PEN-2"]);
    expect(board.buckets.triage[0]!.unread).toBe(true);
    expect(board.buckets.today[0]).toMatchObject({ assignee: CLAUDE, executor: { effort: "high" }, unread: false, carried: 2 });
    expect(board.buckets.triage[0]!.carried).toBeUndefined();
    expect(board.brief).toEqual({ id: "b", identifier: "PEN-9", title: "Daily Brief", description: "# Brief" });
    expect(board.done.map((x) => x.identifier)).toEqual(["PEN-4"]);
  });
});

describe("edits", () => {
  const ctx = { me: "user-1", assignees: list, labels };

  it("keeps the hidden source marker when the description is edited", () => {
    expect(keepMarkers("Old\n\n<!-- source:source:slack:C1:1.2 -->", "New text <!-- sneaky -->")).toBe("New text\n\n<!-- source:source:slack:C1:1.2 -->");
    expect(keepMarkers("Plain", "New")).toBe("New");
    expect(paperclipUpdate(issue(), { description: "Edited" }, ctx).description).toBe("Edited\n\n<!-- source:source:slack:C1:1.2 -->");
  });

  it("assigns only to you, the Assistant or an Engineer, and clears the model override", () => {
    expect(paperclipUpdate(issue(), { assignee: CLAUDE }, ctx)).toEqual({ assigneeAgentId: CLAUDE, assigneeUserId: null, assigneeAdapterOverrides: null });
    expect(paperclipUpdate(issue({ assigneeAgentId: CLAUDE, assigneeUserId: null }), { assignee: "me" }, ctx)).toEqual({ assigneeUserId: "user-1", assigneeAgentId: null, assigneeAdapterOverrides: null });
    expect(() => paperclipUpdate(issue(), { assignee: "00000000-0000-0000-0000-0000000000ee" }, ctx)).toThrow(BadRequest);
  });

  it("sets model and effort for Engineers only, as Paperclip's picker stores them", () => {
    const onCodex = issue({ assigneeAgentId: CODEX, assigneeUserId: null });
    expect(paperclipUpdate(onCodex, { model: "gpt-5.6-sol", effort: "xhigh" }, ctx).assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "gpt-5.6-sol", modelReasoningEffort: "xhigh" } });
    // Effort alone keeps the model override already there.
    const withModel = issue({ assigneeAgentId: CODEX, assigneeUserId: null, assigneeAdapterOverrides: { adapterConfig: { model: "gpt-6-astra" } } });
    expect(paperclipUpdate(withModel, { effort: "low" }, ctx).assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "gpt-6-astra", modelReasoningEffort: "low" } });
    // The Engineer's primary model is no override.
    expect(paperclipUpdate(issue({ assigneeAgentId: CLAUDE, assigneeUserId: null }), { model: "claude-opus-5-5", effort: "" }, ctx).assigneeAdapterOverrides).toBeNull();
    expect(paperclipUpdate(issue(), { assignee: GLM, model: "z-ai/glm-5.3" }, ctx).assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "openrouter/z-ai/glm-5.3" } });
    expect(() => paperclipUpdate(issue(), { model: "gpt-5.6-sol" }, ctx)).toThrow(/Engineer/);
    expect(() => paperclipUpdate(onCodex, { effort: "max" }, ctx)).toThrow(/effort/);
    expect(() => paperclipUpdate(issue(), { labelIds: ["00000000-0000-0000-0000-0000000000ff"] }, ctx)).toThrow(/label/);
  });

  it("accepts only known fields and values", () => {
    expect(UpdateSchema.safeParse({ status: "blocked" }).success).toBe(false);
    expect(UpdateSchema.safeParse({ assigneeAgentId: CODEX }).success).toBe(false);
    expect(UpdateSchema.safeParse({ model: "gpt; rm -rf" }).success).toBe(false);
    expect(UpdateSchema.safeParse({ status: "done", priority: "high" }).success).toBe(true);
  });
});

describe("comments", () => {
  it("names the author and hides markers", () => {
    expect(commentView({ id: "1", body: "Done.\n\n<!-- pennyworth-runner -->", authorType: "user", authorUserId: "user-1", createdAt: "t" }, "user-1", agents)).toMatchObject({ body: "Done.", author: { kind: "runner" } });
    expect(commentView({ id: "2", body: "Hi", authorType: "user", authorUserId: "user-1", createdAt: "t" }, "user-1", agents).author).toEqual({ kind: "me", name: "You" });
    expect(commentView({ id: "3", body: "Draft", authorType: "agent", authorAgentId: "00000000-0000-0000-0000-00000000000a", createdAt: "t" }, "user-1", agents).author).toEqual({ kind: "agent", name: "Assistant" });
  });

  it("says who reads your reply", () => {
    expect(replyTarget(issue({ assigneeAgentId: CODEX }), list)).toMatch(/runner/);
    expect(replyTarget(issue({ labels: [{ id: "x", name: "needs-review", color: "" }] }), list)).toMatch(/pick N/);
    expect(replyTarget(issue(), list)).toMatch(/Assistant picks up/);
  });
});

describe("request guard", () => {
  const hosts = ["localhost:3120", "127.0.0.1:3120"];
  const req = (method: string, headers: Record<string, string>) => ({ method, url: "/api/x", headers: { host: "localhost:3120", ...headers } });
  const ok = { "content-type": "application/json", "x-pennyworth-board": "1", origin: "http://localhost:3120", "sec-fetch-site": "same-origin" };

  it("answers only to its own host names (DNS rebinding)", () => {
    expect(checkRequest(req("GET", { host: "evil.example:3120" }), hosts)).toBe("unknown host");
    expect(checkRequest(req("GET", {}), hosts)).toBeUndefined();
  });

  it("takes writes only as same-origin JSON with the board header", () => {
    expect(checkRequest(req("POST", ok), hosts)).toBeUndefined();
    expect(checkRequest(req("POST", { ...ok, "content-type": "text/plain" }), hosts)).toBe("JSON only");
    expect(checkRequest(req("POST", { ...ok, "x-pennyworth-board": "" }), hosts)).toBe("missing board header");
    expect(checkRequest(req("POST", { ...ok, origin: "http://evil.example" }), hosts)).toBe("cross-origin");
    expect(checkRequest(req("POST", { ...ok, origin: "null" }), hosts)).toBe("opaque origin");
    expect(checkRequest(req("POST", { ...ok, "sec-fetch-site": "cross-site" }), hosts)).toBe("cross-site");
  });
});
