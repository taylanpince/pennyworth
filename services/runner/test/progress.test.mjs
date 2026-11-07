import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { progressTracker } from "../src/progress.mjs";

const said = (t) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const use = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id, content, extra = {}) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] }, ...extra });

describe("progressTracker", () => {
  it("Claude Code: its latest words and the task list its task tools build", () => {
    const p = progressTracker();
    assert.equal(p.take(said("Pulling the guard logs first.")), true);
    assert.equal(p.take(use("t1", "TaskCreate", { subject: "Pull guard logs", description: "…" })), false);
    assert.equal(p.take(result("t1", "Task #1 created successfully: Pull guard logs", { tool_use_result: { task: { id: "1", subject: "Pull guard logs" } } })), true);
    p.take(use("t2", "TaskCreate", { subject: "Compare with last week" }));
    p.take(result("t2", "Task #2 created successfully: Compare with last week")); // no tool_use_result: the id from the text
    p.take(use("u1", "TaskUpdate", { taskId: "1", status: "completed" }));
    p.take(use("u2", "TaskUpdate", { taskId: "2", status: "in_progress" }));
    assert.equal(p.take(use("u3", "TaskUpdate", { taskId: "2", status: "in_progress" })), false);
    const now = p.current();
    assert.equal(now.said, "Pulling the guard logs first.");
    assert.ok(now.saidAt);
    assert.deepEqual(now.plan, [
      { text: "Pull guard logs", state: "done" },
      { text: "Compare with last week", state: "doing" },
    ]);
    p.take(use("u4", "TaskUpdate", { taskId: "1", status: "deleted" }));
    assert.deepEqual(p.current().plan, [{ text: "Compare with last week", state: "doing" }]);
    // The final NO_REPLY isn't something to show.
    assert.equal(p.take(said("NO_REPLY")), false);
  });

  it("TodoWrite (older Claude Code) and opencode's todowrite replace the whole list", () => {
    const p = progressTracker();
    p.take(use("t", "TodoWrite", { todos: [{ content: "Fix it", activeForm: "Fixing it", status: "in_progress" }, { content: "Test it", status: "pending" }] }));
    assert.deepEqual(p.current().plan, [{ text: "Fixing it", state: "doing" }, { text: "Test it", state: "todo" }]);
    const o = progressTracker();
    o.take({ type: "text", part: { text: "The emails come from the cron." } });
    o.take({ type: "tool_use", part: { tool: "todowrite", state: { input: { todos: [{ content: "Remove email sending", status: "completed" }] } } } });
    assert.deepEqual(o.current(), { said: "The emails come from the cron.", saidAt: o.current().saidAt, plan: [{ text: "Remove email sending", state: "done" }] });
  });

  it("Codex: finished messages, and the plan's first open item is the one it's on", () => {
    const p = progressTracker();
    assert.equal(p.take({ type: "item.started", item: { type: "agent_message", text: "half" } }), false);
    p.take({ type: "item.completed", item: { type: "agent_message", text: "Reading the handler." } });
    p.take({ type: "item.updated", item: { type: "todo_list", items: [{ text: "Read", completed: true }, { text: "Fix", completed: false }, { text: "Test", completed: false }] } });
    assert.equal(p.current().said, "Reading the handler.");
    assert.deepEqual(p.current().plan.map((i) => i.state), ["done", "doing", "todo"]);
  });

  it("nothing to show until the agent says or plans something; long words are cut", () => {
    const p = progressTracker();
    assert.deepEqual(p.current(), {});
    assert.equal(p.take({ type: "system", subtype: "thinking_tokens" }), false);
    p.take(said("x".repeat(2000)));
    assert.equal(p.current().said.length, 600);
  });
});
