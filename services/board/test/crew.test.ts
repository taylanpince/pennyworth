import { describe, expect, it } from "vitest";
import { assignees, buildBoard } from "../src/board.js";
import { crewOf, foldedChildren, handOverText, issueState, mostUrgent, summaryOf, type CrewInput } from "../src/crew.js";
import type { Agent, Issue } from "../src/paperclip.js";

const ME = "user-1";
const agents: Agent[] = [
  { id: "a-alfred", name: "Assistant", status: "idle", adapterType: "codex_local", metadata: { setupKey: "pennyworth:assistant" } },
  { id: "a-grace", name: "Engineer · Codex", status: "idle", adapterType: "codex_local", metadata: { setupKey: "pennyworth:engineer" } },
  { id: "a-ada", name: "Engineer · Claude", status: "idle", adapterType: "claude_local", metadata: { setupKey: "pennyworth:engineer-claude" } },
];
const list = assignees(agents);
let n = 0;
const issue = (o: Partial<Issue>): Issue => ({
  id: `i-${++n}`, identifier: `PEN-${n}`, title: "t", description: "", status: "todo", priority: "medium",
  assigneeUserId: null, assigneeAgentId: null, assigneeAdapterOverrides: null,
  createdAt: `2026-10-26T10:00:${String(n).padStart(2, "0")}Z`, updatedAt: "2026-10-26T10:00:00Z", lastActivityAt: "2026-10-26T10:00:00Z", ...o,
});
const SEEN = "2026-10-26T11:00:00Z";
const input = (o: Partial<CrewInput> = {}): CrewInput => ({ assignees: list, seen: () => SEEN, working: new Map(), jobs: new Map(), ...o });

describe("folding sub-tasks into their card (D-45)", () => {
  const parent = issue({ assigneeUserId: ME });
  const grace = issue({ parentId: parent.id, assigneeAgentId: "a-grace" });
  const deeper = issue({ parentId: grace.id, assigneeAgentId: "a-ada" });
  const mine = issue({ parentId: parent.id, assigneeUserId: ME });
  const orphan = issue({ parentId: "i-gone", assigneeAgentId: "a-grace" });

  it("folds agents' sub-tasks into the top-most task the board shows, and nothing else", () => {
    const f = foldedChildren([parent, grace, deeper, mine, orphan], list);
    expect([...f]).toEqual([[grace.id, parent.id], [deeper.id, parent.id]]);
  });

  it("shows one card with its crew, the sub-tasks gone from the columns", () => {
    const board = buildBoard({ open: [parent, grace, deeper, mine, orphan], closed: [], placements: new Map(), seen: new Map(), installedAt: SEEN, assignees: list, crew: { working: new Map([[grace.identifier, { since: "2026-10-26T11:30:00Z", queued: false }]]), jobs: new Map() } });
    expect(board.buckets.triage.map((c) => c.identifier)).toEqual(expect.arrayContaining([parent.identifier, mine.identifier, orphan.identifier]));
    expect(board.buckets.triage.map((c) => c.identifier)).not.toContain(grace.identifier);
    const card = board.buckets.triage.find((c) => c.id === parent.id)!;
    expect(card.crew!.map((m) => [m.agent, m.state])).toEqual([["a-grace", "working"], ["a-ada", "queued"]]);
    expect(card.crew![0]!.since).toBe("2026-10-26T11:30:00Z");
  });

  it("keeps a closed sub-task on its card, out of Done", () => {
    const done = issue({ parentId: parent.id, assigneeAgentId: "a-ada", status: "done" });
    const board = buildBoard({ open: [parent], closed: [done], placements: new Map(), seen: new Map(), installedAt: SEEN, assignees: list, crew: { working: new Map(), jobs: new Map() } });
    expect(board.done).toEqual([]);
    expect(board.buckets.triage[0]!.crew).toEqual([{ agent: "a-ada", state: "done", issues: [{ id: done.id, identifier: done.identifier, title: "t", state: "done" }] }]);
  });
});

describe("an agent's state", () => {
  const ada = list.find((a) => a.key === "a-ada")!;
  it("working or queued from the activity, first", () => {
    const i = issue({ assigneeAgentId: "a-ada", lastActivityAt: "2026-10-26T12:00:00Z" });
    expect(issueState(i, ada, input({ working: new Map([[i.identifier, { since: null, queued: true }]]) }))).toBe("queued");
  });
  it("proposed: an Engineer task an agent made, waiting for the go-ahead", () => {
    expect(issueState(issue({ assigneeAgentId: "a-ada", createdByAgentId: "a-alfred" }), ada, input())).toBe("proposed");
    expect(issueState(issue({ assigneeAgentId: "a-ada", createdByAgentId: "a-alfred", createdByUserId: ME }), ada, input())).toBe("queued");
  });
  it("failed from the runner's last job, until it runs again", () => {
    const i = issue({ assigneeAgentId: "a-ada", status: "in_review" });
    expect(issueState(i, ada, input({ jobs: new Map([[i.identifier, "timeout"]]) }))).toBe("failed");
    expect(issueState(i, ada, input({ jobs: new Map([[i.identifier, "done"]]) }))).toBe("done");
  });
  it("queued only until someone touches it: an agent waiting on you after a reply isn't queued", () => {
    const fresh = issue({ assigneeAgentId: "a-ada", createdAt: "2026-10-26T10:00:00Z", lastActivityAt: "2026-10-26T10:00:05Z" });
    expect(issueState(fresh, ada, input())).toBe("queued");
    expect(issueState({ ...fresh, lastActivityAt: "2026-10-26T10:30:00Z" }, ada, input())).toBe("done");
  });
  it("needs you: something new you haven't read", () => {
    expect(issueState(issue({ assigneeAgentId: "a-ada", status: "in_review", lastActivityAt: "2026-10-26T12:00:00Z" }), ada, input())).toBe("needs");
    expect(issueState(issue({ assigneeAgentId: "a-ada", status: "done", lastActivityAt: "2026-10-26T12:00:00Z" }), ada, input())).toBe("needs");
    expect(issueState(issue({ assigneeAgentId: "a-ada", status: "done" }), ada, input())).toBe("done");
  });
});

describe("the crew of a card", () => {
  it("groups a fan-out under one agent, Assistant first, with how many finished", () => {
    const parent = issue({ assigneeUserId: ME });
    const kids = [
      issue({ parentId: parent.id, assigneeAgentId: "a-grace", status: "in_review" }),
      issue({ parentId: parent.id, assigneeAgentId: "a-grace", status: "in_review", lastActivityAt: "2026-10-26T12:00:00Z" }),
      issue({ parentId: parent.id, assigneeAgentId: "a-grace", status: "in_progress" }),
      issue({ parentId: parent.id, assigneeAgentId: "a-alfred", status: "in_review" }),
    ];
    const working = new Map([[kids[2]!.identifier, { since: "2026-10-26T11:50:00Z", queued: false }]]);
    const crew = crewOf(parent, kids, input({ working }));
    expect(crew.map((m) => [m.agent, m.state, m.finished])).toEqual([["a-alfred", "done", undefined], ["a-grace", "needs", 2]]);
    expect(crew[1]!.issues.map((i) => i.state)).toEqual(["done", "needs", "working"]);
  });
  it("a task from before D-45, assigned straight to an agent, has that agent as its crew", () => {
    const t = issue({ assigneeAgentId: "a-ada", status: "in_review" });
    expect(crewOf(t, [], input()).map((m) => [m.agent, m.issues[0]!.id])).toEqual([["a-ada", t.id]]);
    expect(crewOf(issue({ assigneeUserId: ME }), [], input())).toEqual([]);
  });
  it("most urgent first: you, then stuck, then to approve", () => {
    expect(mostUrgent(["working", "failed", "proposed"])).toBe("failed");
    expect(mostUrgent([])).toBe("done");
  });
});

describe("words between the crew and the board", () => {
  it("sums up an agent's comment in one line", () => {
    expect(summaryOf("## Summary\n\nFixed the **flaky** test in [board](https://x/y).\n\n```\nlog\n```\n<!-- pennyworth-runner -->")).toBe("Fixed the flaky test in board. …");
    expect(summaryOf("a".repeat(300)).length).toBe(180);
  });
  it("hands over the user's instructions with a note, never the stuck agent's text", () => {
    expect(handOverText("Fix the flaky e2e test.\n", "Linus")).toBe("Fix the flaky e2e test.\n\nLinus worked on this first and got stuck; their notes are on the task.");
  });
});
