import { describe, expect, it } from "vitest";
import { RunnerReportSchema, agentsView, runTasks, workingOn, type RunContext } from "../src/activity.js";
import type { Agent, LiveRun, PastRun } from "../src/paperclip.js";

const NOW = Date.parse("2026-10-12T15:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const agents = [{ id: "a-assistant", name: "Assistant" }, { id: "a-slack", name: "Slack Scout" }] as Agent[];

describe("runTasks", () => {
  it("a run on the user's task works on that task", () => {
    expect(runTasks({ identifier: "PEN-876", title: "Agenda", description: "", originKind: "manual" }, "PEN")).toEqual([{ identifier: "PEN-876", title: "Agenda" }]);
  });
  it("a routine run works on the tasks its description names, and a scan on none", () => {
    const replies = { identifier: "PEN-873", title: "Process task replies", description: "Today is 2026-10-12. Process replies on: PEN-864, PEN-863, PEN-864", originKind: "routine_execution" };
    expect(runTasks(replies, "PEN")).toEqual([{ identifier: "PEN-864" }, { identifier: "PEN-863" }]);
    expect(runTasks({ ...replies, title: "Slack scan", description: "Find Slack messages for PEN-873 and XPEN-12" }, "PEN")).toEqual([]);
  });
});

describe("agentsView", () => {
  const contexts: Record<string, RunContext> = {
    "i-replies": { run: { identifier: "PEN-873", title: "Process task replies" }, tasks: [{ identifier: "PEN-864", title: "Check RPC states" }] },
    "i-scan": { run: { identifier: "PEN-871", title: "Slack scan" }, tasks: [] },
  };
  const resolve = async (id: string | null) => (id && contexts[id]) || { run: null, tasks: [] };
  const live = [
    { id: "r1", status: "running", agentId: "a-assistant", issueId: "i-replies", startedAt: ago(3), createdAt: ago(3), currentStatusMessage: "Receiving agent output", outputSilence: { level: "ok" } },
    { id: "r2", status: "running", agentId: "a-slack", issueId: "i-scan", startedAt: ago(1), createdAt: ago(1), outputSilence: { level: "suspicious" } },
  ] as LiveRun[];
  const past = [
    { id: "p1", status: "succeeded", agentId: "a-assistant", issueId: "i-replies", startedAt: ago(30), finishedAt: ago(28), error: null },
    { id: "p2", status: "failed", agentId: "a-slack", issueId: "i-scan", startedAt: ago(60 * 20), finishedAt: ago(60 * 19), error: null },
    { id: "r1", status: "running", agentId: "a-assistant", issueId: "i-replies", startedAt: ago(3), finishedAt: null, error: null },
  ] as PastRun[];
  const runner = {
    at: ago(1),
    running: [{ issueId: "11111111-1111-1111-1111-111111111111", identifier: "PEN-900", engine: "Codex (gpt-5.5)", mode: "implement", repo: "org/repo", startedAt: ago(10) }],
    queued: [{ issueId: "22222222-2222-2222-2222-222222222222", identifier: "PEN-901" }],
    recent: [{ issueId: "33333333-3333-3333-3333-333333333333", identifier: "PEN-899", engine: "Claude Code", status: "done", startedAt: ago(50), finishedAt: ago(40) }],
  };

  it("lists Paperclip runs and runner jobs with their tasks, and what finished in the last 12 hours", async () => {
    const view = await agentsView({ live, past, runner, agents, resolve, now: NOW });
    expect(view.sessions.map((s) => [s.agent, s.state, s.tasks.map((t) => t.identifier)])).toEqual([
      ["Assistant", "working", ["PEN-864"]],
      ["Slack Scout", "working", []],
      ["Engineer · Codex (gpt-5.5)", "working", ["PEN-900"]],
      ["Engineer", "queued", ["PEN-901"]],
    ]);
    expect(view.sessions[1]!.quiet).toBe(true);
    expect(view.sessions[2]!.doing).toBe("Implement in org/repo");
    expect(view.finished.map((f) => [f.agent, f.status])).toEqual([
      ["Assistant", "succeeded"],
      ["Engineer · Claude Code", "done"],
    ]);
    expect(view.runner).toEqual({ reportedAt: runner.at, stale: false });
  });

  it("drops a silent runner's jobs from the live list and says so", async () => {
    const view = await agentsView({ live: [], past: [], runner: { ...runner, at: ago(10) }, agents, resolve, now: NOW });
    expect(view.sessions).toEqual([]);
    expect(view.runner.stale).toBe(true);
    expect(view.finished).toHaveLength(1);
  });

  it("marks the tasks being worked on, preferring a running agent over a queue", async () => {
    const view = await agentsView({ live, past: [], runner: { ...runner, queued: [{ issueId: runner.running[0]!.issueId, identifier: "PEN-864" }] }, agents, resolve, now: NOW });
    const map = workingOn(view.sessions);
    expect(map.get("PEN-864")).toEqual({ agent: "Assistant", since: ago(3), queued: false });
    expect(map.get("PEN-900")?.queued).toBe(false);
    expect(map.has("PEN-871")).toBe(false);
  });
});

describe("runner report", () => {
  it("accepts the runner's shape and nothing else", () => {
    expect(RunnerReportSchema.safeParse({ running: [], queued: [], recent: [] }).success).toBe(true);
    expect(RunnerReportSchema.safeParse({ running: [{ issueId: "x", identifier: "PEN-1", startedAt: ago(1) }], queued: [], recent: [] }).success).toBe(false);
    expect(RunnerReportSchema.safeParse({ running: [], queued: [], recent: [], extra: 1 }).success).toBe(false);
  });
});
