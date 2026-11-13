// What a job used (D-62), from fixtures cut from real job logs (structural fields only: no text).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { isRetry, jobUsage, logHeader, usageFromEvents, usageFromLog } from "../src/usage.mjs";

const fixture = (name) => join(import.meta.dirname, "fixtures/usage", name);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);

describe("usage from Claude Code's events", () => {
  it("counts a new session's totals as the job's own", async () => {
    const { header, usage } = await usageFromLog(fixture("claude-new-session.ndjson"));
    assert.deepEqual(header, { at: "2026-11-02T15:19:33.996Z", kind: "claude", model: "claude-opus-5-5" });
    assert.equal(usage.sessionId, "session-1");
    close(usage.costUsd, 0.8867484);
    assert.equal(usage.cacheReadTokens, 1697382);
    assert.equal(usage.outputTokens, 10344);
    assert.equal(usage.turns, 25);
    close(usage.sessionCostAfter, usage.costUsd);
  });

  it("counts a resumed session's job by what it added to the session's running totals", async () => {
    const first = (await usageFromLog(fixture("claude-new-session.ndjson"))).usage;
    const { usage } = await usageFromLog(fixture("claude-resumed.ndjson"), { previousSession: (id) => (id === first.sessionId ? first.sessionAfter : undefined) });
    // The session's total is $1.53; this job added $0.64 of it.
    close(usage.sessionCostAfter, 1.5300048);
    close(usage.costUsd, 1.5300048 - 0.8867484);
    assert.equal(usage.cacheReadTokens, 1557582, "the same as the run's own result: modelUsage climbs by exactly that");
    assert.equal(usage.inputTokens, 30);
    // Without the previous job's totals, the whole session would be counted again.
    close((await usageFromLog(fixture("claude-resumed.ndjson"))).usage.costUsd, 1.5300048);
  });

  it("counts the whole session when its totals went down (not the session it seemed)", async () => {
    const { usage } = await usageFromLog(fixture("claude-resumed.ndjson"), { previousSession: { costUsd: 50, inputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, outputTokens: 1, reasoningTokens: 1 } });
    close(usage.costUsd, 1.5300048);
  });

  it("takes several results in one job (streamed input) as one, and counts subagents and tools once (PEN-2964)", async () => {
    const { usage } = await usageFromLog(fixture("claude-subagents.ndjson"));
    close(usage.costUsd, 23.933298); // the last result's total, not the sum of 13 results' totals (~$265)
    assert.equal(usage.subagents, 12, "spawned is a running count per process: its largest, not the sum (150)");
    assert.equal(usage.tools.Agent, 12);
    assert.equal(usage.tools.Bash, 442);
    assert.deepEqual(usage.mcp, { slack: 1, glean: 1 });
    assert.equal(usage.contextTokens, 115993, "the last request's input");
  });
});

describe("usage from Codex's events", () => {
  it("subtracts the thread's earlier totals, splits cached input out, and has no cost", async () => {
    const first = (await usageFromLog(fixture("codex-new-thread.ndjson"))).usage;
    assert.equal(first.costUsd, null);
    assert.equal(first.inputTokens + first.cacheReadTokens, 1024292);
    assert.equal(first.cacheReadTokens, 953472);
    const { header, usage } = await usageFromLog(fixture("codex-resumed.ndjson"), { previousSession: () => first.sessionAfter });
    assert.equal(header.model, "gpt-5.6-sol");
    assert.equal(usage.sessionId, first.sessionId);
    assert.equal(usage.inputTokens + usage.cacheReadTokens, 4049652 - 1024292);
    assert.equal(usage.outputTokens, 22470 - 7241);
    assert.equal(usage.reasoningTokens, 5871 - 3027);
    assert.equal(usage.turns, 1);
    assert.ok(usage.tools.command > 0);
  });
});

describe("usage from opencode's events", () => {
  it("adds up each step's tokens and cost", async () => {
    const { usage } = await usageFromLog(fixture("opencode.ndjson"));
    assert.equal(usage.turns, 5);
    close(usage.costUsd, 0.0031153653 + 0.0031262917 + 0.0030524221 + 0.0030926065 + 0.0033541866);
    assert.equal(usage.sessionAfter, null, "nothing to carry: steps don't repeat earlier ones");
    assert.ok(usage.outputTokens >= usage.reasoningTokens);
  });

  it("names MCP tools like the other engines", () => {
    const usage = usageFromEvents([JSON.stringify({ type: "tool_use", part: { tool: "primer_primer_get_document" } }), JSON.stringify({ type: "tool_use", part: { tool: "bash" } })], { engine: "openrouter" });
    assert.deepEqual(usage.tools, { mcp__primer__primer_get_document: 1, bash: 1 });
    assert.deepEqual(usage.mcp, { primer: 1 });
  });
});

describe("a job's record", () => {
  it("is empty, not an error, when the run never reported", () => {
    const usage = usageFromEvents(["# header", "not json", ""], { engine: "claude" });
    assert.equal(usage.costUsd, null);
    assert.equal(usage.inputTokens, 0);
    assert.equal(logHeader("garbage"), undefined);
  });

  it("tells a short request to do it again from anything else", () => {
    for (const s of ["try again", "Please try it again", "retry", "Run that again please", "again", "<!-- pennyworth-from:PEN-3 -->Push it again"]) assert.ok(isRetry(s), s);
    for (const s of ["Try a different approach", "Can you try again with the staging logs and the prod ones, and then compare the error rates between them?", "Check the logs again", ""]) assert.ok(!isRetry(s), s);
  });

  it("becomes the board's JobUsage", () => {
    const row = { id: 7, issue_id: "i", identifier: "PEN-7", agent_id: "a", engine: "Codex (gpt-5.6-sol, high effort)", model: "gpt-5.6-sol", effort: "high", status: "done", started_at: "2026-11-01T00:00:00Z", finished_at: "2026-11-01T00:01:00Z", resumed: 1, restarted: 0, retry: null, usage_json: JSON.stringify({ inputTokens: 1, costUsd: null, tools: { command: 2 }, mcp: {} }) };
    const job = jobUsage(row);
    assert.equal(job.engine, "codex");
    assert.equal(job.resumed, true);
    assert.equal(job.retry, false);
    assert.equal(job.costUsd, null);
    assert.equal(job.outputTokens, 0);
  });
});
