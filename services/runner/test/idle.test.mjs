import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { idleCandidate, prepareInstructions } from "../src/idle.mjs";

const task = (fields = {}) => ({ id: "t", status: "todo", assigneeUserId: "me", assigneeAgentId: null, parentId: null, labels: [], ...fields });

describe("idle work", () => {
  it("takes the user's open tasks that nobody is on", () => {
    assert.ok(idleCandidate(task(), [], "me"));
    assert.ok(idleCandidate(task({ status: "in_progress" }), [{ assigneeUserId: "me" }], "me"), "a subtask isn't someone on it");
    assert.ok(!idleCandidate(task(), [{ assigneeAgentId: "ada", status: "done" }], "me"), "an agent was on it, even if done");
    assert.ok(!idleCandidate(task({ status: "in_review" }), [], "me"));
    assert.ok(!idleCandidate(task({ assigneeUserId: "someone" }), [], "me"));
    assert.ok(!idleCandidate(task({ parentId: "p" }), [], "me"), "subtasks open from their task");
    for (const name of ["recurring", "needs-review", "hands-off", "daily-brief"]) assert.ok(!idleCandidate(task({ labels: [{ name }] }), [], "me"), name);
  });


  it("tells Alfred to prepare, never to act, and whose words the task is", () => {
    const theirs = prepareInstructions("Taylan", false);
    assert.match(theirs, /untrusted data/);
    assert.match(theirs, /task_create_engineer_task: it waits for Taylan's Approve/);
    assert.match(theirs, /Don't publish, send, post to GitHub or Jira/);
    assert.match(prepareInstructions("Taylan", true), /note to themselves/);
    assert.doesNotMatch(prepareInstructions("Taylan", true), /untrusted/);
  });
});
