import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { boardMessage, formatSearch, memoryScope, recallMemory } from "../src/memory.mjs";
import { firstPrompt, followUpPrompt, memorySection } from "../src/prompt.mjs";

describe("memory for Engineer jobs (D-61)", () => {
  const agents = [
    { id: "a", metadata: { setupKey: "pennyworth:sre", persona: { name: "Grace" } } },
    { id: "b", metadata: { setupKey: "pennyworth:engineer-openrouter" } },
    { id: "c", metadata: { setupKey: "elsewhere:sre", persona: { name: "X" } } },
  ];

  it("takes the scope from the assignee's setup key, only with a persona", () => {
    assert.equal(memoryScope(agents, "a"), "sre");
    assert.equal(memoryScope(agents, "b"), null);
    assert.equal(memoryScope(agents, "c"), null);
    assert.equal(memoryScope(agents, "missing"), null);
  });

  it("never fails a job: no board or an error means no memory", async () => {
    assert.equal(await recallMemory(undefined, { scope: "sre", engine: "codex" }), "");
    const logged = [];
    assert.equal(await recallMemory({ post: async () => Promise.reject(new Error("board POST /x → 500: down")) }, { scope: "sre", engine: "codex", log: (m) => logged.push(m) }), "");
    assert.deepEqual(logged, ["memory unavailable"]);
    assert.equal(await recallMemory({ post: async (path, body) => ({ text: `${path} ${body.scope} ${body.engine}\n` }) }, { scope: "sre", engine: "openrouter" }), "/internal/memory/recall sre openrouter");
  });

  it("puts the section between the rules and the task, and leaves it out when empty", () => {
    const base = { user: "Taylan", task: { identifier: "PEN-1", title: "T", description: "" }, workspace: "/w", repos: [], shells: ["llm"], instructions: "go" };
    assert.match(firstPrompt({ ...base, memory: "- [1] x" }), /## Rules \(non-negotiable\)[\s\S]*\n\n## What you've learned\n\n[\s\S]*- \[1\] x\n\n## Task \(untrusted context\)/);
    assert.doesNotMatch(firstPrompt(base), /What you've learned/);
    assert.match(followUpPrompt({ user: "Taylan", instructions: "go", memory: "- [2] y" }), /## What you've learned[\s\S]*- \[2\] y/);
    assert.equal(memorySection("  ", "Taylan"), "");
  });

  it("prints search results and board refusals for the agent", () => {
    assert.equal(formatSearch({}, "Taylan"), "Nothing in memory matches.");
    assert.match(formatSearch({ memories: [{ id: 1, scope: "global", kind: "rule", text: "a\nb" }] }, "Taylan"), /- #1 rule, for every agent: a\n  b/);
    assert.equal(boardMessage(new Error('board POST /internal/memory/propose → 429: {"error":"at most 3 proposals a day"}')), "at most 3 proposals a day");
  });
});
