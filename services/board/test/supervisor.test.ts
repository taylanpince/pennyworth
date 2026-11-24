import { describe, expect, it } from "vitest";
import type { Assignee, Card } from "../src/board.js";
import type { Issue } from "../src/paperclip.js";
import { sourceOf, supervisorInstructions, supervisorRefusal, supervisorView, type SupervisorAssignment } from "../src/supervisor.js";

const crew: Assignee[] = [
  { key: "me", kind: "me", name: "You" },
  { key: "ada", kind: "engineer", name: "Engineer", persona: { name: "Ada", voice: "", avatar: "ada" } },
  { key: "alfred", kind: "assistant", name: "Assistant", persona: { name: "Alfred", voice: "", avatar: "alfred" } },
];
const issue = (fields: Partial<Issue> = {}) => ({ id: "t1", identifier: "PEN-1", title: "Fix the relayer retry", status: "todo", priority: "medium", labels: [], description: "Retry RPC calls.", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-20T00:00:00Z", ...fields }) as Issue;
const NOW = Date.parse("2026-11-22T12:00:00Z");
const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const refusal = (over: Partial<Parameters<typeof supervisorRefusal>[0]> = {}) => supervisorRefusal({ issue: issue(), bucket: "today", agentName: "Ada", assignees: crew, parts: [], recent: [], now: NOW, ...over });

describe("the supervisor's assignments", () => {
  it("allows a crew member by name on a task nobody's on", () => {
    expect(refusal()).toBeUndefined();
    expect(refusal({ agentName: "alfred" })).toBeUndefined();
  });

  it("refuses what isn't hers to assign", () => {
    expect(refusal({ agentName: "Bob" })).toMatch(/no crew member is called Bob: Ada, Alfred/);
    expect(refusal({ agentName: "You" })).toMatch(/no crew member/);
    expect(refusal({ bucket: "triage" })).toMatch(/PEN-1 is in Triage/);
    for (const bucket of ["tomorrow", "backlog", "later"] as const) expect(refusal({ bucket })).toBeUndefined();
    for (const name of ["needs-review", "recurring", "daily-brief", "hands-off"]) expect(refusal({ issue: issue({ labels: [{ id: "l", name, color: "" }] as Issue["labels"] }) })).toMatch(name);
    expect(refusal({ issue: issue({ description: "Board review.\n\n<!-- source:supervisor:2026-11-22 -->" }) })).toMatch(/your own report/);
    expect(refusal({ parts: [issue({ id: "p", identifier: "PEN-2", assigneeAgentId: "ada", status: "in_review" })] })).toMatch(/Ada is already on PEN-1 \(PEN-2\)/);
  });

  it("assigns each task and crew member once, at most 5 a pass and 15 a day", () => {
    const one = (task: string, hours: number, agent = "Ada"): SupervisorAssignment => ({ task, part: "PEN-9", partId: "p", agent, at: at(hours) });
    expect(refusal({ recent: [one("PEN-1", 30)] })).toMatch(/once per task and crew member/);
    expect(refusal({ recent: [one("PEN-1", 30, "Alfred")] })).toBeUndefined();
    expect(refusal({ recent: [1, 2, 3, 4, 5].map((n) => one(`PEN-${n + 10}`, 1)) })).toMatch(/5 assignments in two hours/);
    expect(refusal({ recent: Array.from({ length: 15 }, (_, n) => one(`PEN-${n + 10}`, 3 + n)) })).toMatch(/15 assignments a day/);
  });

  it("says where a task came from and leaves her reason for the user", () => {
    expect(sourceOf(issue({ description: "x\n\n<!-- source:source:slack:C1:1.2 -->" }))).toBe("slack");
    expect(sourceOf(issue({ description: "x <!-- source:meeting:abc -->" }))).toBe("meeting");
    expect(sourceOf(issue())).toBe("you");
    expect(sourceOf(issue({ createdByAgentId: "a" } as Partial<Issue>))).toBe("agent");
    expect(supervisorInstructions("Add a retry with backoff.", "Clear ask,\n small change.")).toBe("Add a retry with backoff.\n\n_Assigned by the supervisor: Clear ask, small change._");
  });

  it("shows her every column but Triage in the user's order, with each card's crew and source", () => {
    const card = (id: string, extra: Partial<Card> = {}): Card => ({ id, identifier: id.toUpperCase(), title: id, status: "todo", priority: "medium", labels: [], assignee: "me", unread: false, createdAt: "2026-11-01T12:00:00Z", activityAt: "2026-11-20T12:00:00Z", ...extra });
    const buckets = { triage: [card("pen-3")], today: [card("pen-1", { crew: [{ agent: "Ada", state: "working", issues: [] }] })], tomorrow: [], later: [card("pen-5")], backlog: [] };
    const view = supervisorView(buckets, new Map([["pen-1", issue({ id: "pen-1", description: "Do it <!-- source:slack:C:1.2 -->" })]]), NOW);
    expect(view.map((c) => c.column)).toEqual(["today", "tomorrow", "backlog", "later"]);
    expect(view[0]!.tasks[0]).toMatchObject({ task: "PEN-1", from: "slack", age_days: 21, idle_days: 2, crew: [{ agent: "Ada", state: "working" }], description: "Do it" });
    expect(view[3]!.tasks[0]).toMatchObject({ task: "PEN-5", from: "unknown" });
    expect(JSON.stringify(view)).not.toContain("PEN-3");
  });
});
