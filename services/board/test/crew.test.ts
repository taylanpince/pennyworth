import { describe, expect, it } from "vitest";
import { assignees, buildBoard } from "../src/board.js";
import { crewOf, foldedChildren, handOverText, isSubtask, issueState, mostUrgent, partsToClose, subtaskCount, summaryOf, type CrewInput } from "../src/crew.js";
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

  it("folds agents' sub-tasks into the top-most task the board shows, and the user's subtasks into their task", () => {
    const f = foldedChildren([parent, grace, deeper, mine, orphan], list);
    expect([...f]).toEqual([[mine.id, parent.id], [grace.id, parent.id], [deeper.id, parent.id]]);
  });

  it("shows one card with its crew, the sub-tasks gone from the columns", () => {
    const board = buildBoard({ open: [parent, grace, deeper, mine, orphan], closed: [], placements: new Map(), seen: new Map(), installedAt: SEEN, assignees: list, crew: { working: new Map([[grace.identifier, { since: "2026-10-26T11:30:00Z", queued: false }]]), jobs: new Map() } });
    expect(board.buckets.triage.map((c) => c.identifier).sort()).toEqual([parent.identifier, orphan.identifier].sort());
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

describe("subtasks (D-68)", () => {
  const task = issue({ assigneeUserId: ME });
  const a1 = issue({ parentId: task.id, assigneeUserId: ME });
  const a2 = issue({ parentId: task.id, assigneeUserId: ME, status: "done" });
  const a3 = issue({ parentId: task.id, assigneeUserId: ME, status: "cancelled" });
  const ada = issue({ parentId: a1.id, assigneeAgentId: "a-ada" });
  const alfred = issue({ parentId: task.id, assigneeAgentId: "a-alfred" });
  const crew = { working: new Map(), jobs: new Map() };

  it("are one level deep: a child of a subtask, or of an agent's part, isn't one", () => {
    expect(isSubtask(a1, task)).toBe(true);
    expect(isSubtask(issue({ parentId: a1.id, assigneeUserId: ME }), a1)).toBe(false);
    expect(isSubtask(issue({ parentId: alfred.id, assigneeUserId: ME }), alfred)).toBe(false);
    expect(isSubtask(ada, a1)).toBe(false);
  });

  it("fold into their task with their crew's parts, which also show on the task's card", () => {
    const board = buildBoard({ open: [task, a1, ada, alfred], closed: [a2, a3], placements: new Map(), seen: new Map(), installedAt: SEEN, assignees: list, crew });
    expect(board.buckets.triage.map((c) => c.identifier)).toEqual([task.identifier]);
    expect(board.done).toEqual([]);
    const card = board.buckets.triage[0]!;
    expect(card.subtasks).toEqual({ open: 1, total: 2 });
    expect(card.crew!.map((m) => m.agent)).toEqual(["a-alfred", "a-ada"]);
    expect(foldedChildren([task, a1, ada], list).get(ada.id)).toBe(task.id);
  });

  it("take Paperclip's count over the board's 48-hour lists", () => {
    const board = buildBoard({ open: [task, a1], closed: [], placements: new Map(), seen: new Map(), installedAt: SEEN, assignees: list, crew, subtasks: new Map([[task.id, { open: 1, total: 9 }]]) });
    expect(board.buckets.triage[0]!.subtasks).toEqual({ open: 1, total: 9 });
  });

  it("left open on a closed task are cards again, their parts with them", () => {
    const shut = { ...task, status: "done", completedAt: "2026-10-26T12:00:00Z" };
    const board = buildBoard({ open: [a1, ada], closed: [shut, a2], placements: new Map(), seen: new Map(), installedAt: SEEN, assignees: list, crew });
    expect(board.buckets.triage.map((c) => c.identifier)).toEqual([a1.identifier]);
    expect(board.buckets.triage[0]!.crew!.map((m) => m.agent)).toEqual(["a-ada"]);
    expect(board.done.map((c) => c.identifier)).toEqual([task.identifier]);
  });

  it("count without the cancelled", () => {
    expect(subtaskCount(task, [a1, a2, a3, alfred])).toEqual({ open: 1, total: 2 });
    expect(subtaskCount(task, [alfred])).toBeUndefined();
  });
});

describe("parts of a task closed elsewhere (D-45)", () => {
  const closed = (o: Partial<Issue>) => issue({ assigneeUserId: ME, status: "done", completedAt: "2026-10-28T17:15:50Z", ...o });
  const owned = (at: Record<string, string> = {}) => async (part: Issue) => at[part.id];

  it("close with the task when they went quiet before it closed", async () => {
    const parent = closed({});
    const part = issue({ parentId: parent.id, assigneeAgentId: "a-alfred", lastActivityAt: "2026-10-28T16:51:10Z" });
    const dropped = closed({ status: "cancelled", completedAt: null, cancelledAt: "2026-10-28T18:00:00Z" });
    const other = issue({ parentId: dropped.id, assigneeAgentId: "a-grace", lastActivityAt: "2026-10-28T17:00:00Z" });
    const res = await partsToClose([part, other], new Map([parent, dropped].map((p) => [p.id, p])), list, owned());
    expect(res.map((r) => [r.part.id, r.status])).toEqual([[part.id, "done"], [other.id, "cancelled"]]);
  });

  it("close when only the agent spoke after the task closed (a run that finished after the PR merged)", async () => {
    const parent = closed({});
    const part = issue({ parentId: parent.id, assigneeAgentId: "a-ada", status: "in_review", lastActivityAt: "2026-10-28T17:17:07Z" });
    const res = await partsToClose([part], new Map([[parent.id, parent]]), list, owned({ [part.id]: "2026-10-28T17:00:00Z" }));
    expect(res.map((r) => [r.part.id, r.status])).toEqual([[part.id, "done"]]);
    expect(await partsToClose([part], new Map([[parent.id, parent]]), list, owned())).toHaveLength(1);
  });

  it("stay open when the task is open, the user took the part up again, or it's the user's own", async () => {
    const open = issue({ assigneeUserId: ME });
    const parent = closed({});
    const takenUp = issue({ parentId: parent.id, assigneeAgentId: "a-alfred", lastActivityAt: "2026-10-28T18:00:00Z" });
    const parts = [
      issue({ parentId: open.id, assigneeAgentId: "a-alfred" }),
      takenUp,
      issue({ parentId: parent.id, assigneeUserId: ME, lastActivityAt: "2026-10-28T16:00:00Z" }),
      issue({ parentId: "i-unknown", assigneeAgentId: "a-alfred" }),
    ];
    expect(await partsToClose(parts, new Map([open, parent].map((p) => [p.id, p])), list, owned({ [takenUp.id]: "2026-10-28T17:59:00Z" }))).toEqual([]);
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
