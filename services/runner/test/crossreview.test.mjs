import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { closingComment, declined, refusedByPolicy, findingsComment, fixInstructions, reviewChain, reviewInstructions, reviewVerdict } from "../src/crossreview.mjs";

describe("cross-model review", () => {
  it("never reviews a model with its own family by default", () => {
    assert.deepEqual(reviewChain("claude"), [{ kind: "codex", model: "gpt-6-astra" }, { kind: "openrouter", model: "deepseek/deepseek-v4.1-flash" }, { kind: "openrouter", model: "moonshotai/kimi-k3" }]);
    assert.ok(reviewChain("codex").every((e) => e.kind !== "codex"));
    assert.ok(reviewChain("openrouter").every((e) => e.kind !== "openrouter"));
    assert.deepEqual(reviewChain("cad"), []);
  });

  it("takes a configured chain as written, with OpenRouter ids either way", () => {
    const chains = { claude: [{ engine: "openrouter", model: "openrouter/z-ai/glm-5.3" }, { engine: "claude", model: "claude-sonnet-5", effort: "high" }, { engine: "nope" }] };
    assert.deepEqual(reviewChain("claude", chains), [{ kind: "openrouter", model: "z-ai/glm-5.3" }, { kind: "claude", model: "claude-sonnet-5", effort: "high" }]);
    assert.deepEqual(reviewChain("codex", chains), reviewChain("codex"), "other engines keep the defaults");
  });

  it("reads the verdict from the last VERDICT line", () => {
    assert.equal(reviewVerdict("1. **blocking** x\n\nVERDICT: blocking"), "blocking");
    assert.equal(reviewVerdict("VERDICT: blocking\n…on reflection\n**VERDICT: clean**"), "clean");
    assert.equal(reviewVerdict("`VERDICT: clean` is what I'd say"), undefined);
    assert.equal(reviewVerdict("Looks fine."), undefined);
  });

  it("tells a refusal from a review", () => {
    assert.ok(declined({ finished: true, reply: "I'm sorry, but I can't help with reviewing exploit code." }));
    assert.ok(declined({ finished: true, reply: "I can't assist with that request." }));
    assert.ok(!declined({ finished: true, reply: "I can't find a bug here.\n\nVERDICT: clean" }), "a verdict is a review");
    assert.ok(!declined({ finished: true, reply: "The retry loop never stops.\n\nVERDICT: blocking" }));
    assert.ok(declined({ finished: false, reply: "", logTail: 'error: {"code":"invalid_prompt","message":"flagged as potentially violating our usage policy"}' }));
    assert.ok(!declined({ finished: false, reply: "", logTail: "ECONNRESET" }), "a plain failure isn't a refusal (it still moves on, as a failure)");
    // Codex's own words on 2026-11-22, reviewing a wallet-recovery tool.
    const codex = '{"type":"error","message":"This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request."}\n{"type":"turn.failed","error":{"message":"This content was flagged for possible cybersecurity risk."}}';
    assert.ok(declined({ finished: false, reply: "", logTail: codex }));
    assert.ok(refusedByPolicy({ finished: false, logTail: codex }));
    assert.ok(!refusedByPolicy({ finished: false, logTail: "ECONNRESET" }));
  });

  it("writes the runner's own instructions, never as the user", () => {
    const first = reviewInstructions({ prs: ["https://github.com/acme/app/pull/7"], author: "Ada", user: "Taylan", round: 1 });
    assert.match(first, /Review Ada's pull request on this task adversarially[\s\S]*- https:\/\/github\.com\/acme\/app\/pull\/7/);
    assert.match(first, /Don't change code, commit, push or comment on GitHub/);
    assert.match(first, /`VERDICT: blocking`[\s\S]*`VERDICT: clean`/);
    assert.doesNotMatch(first, /round \d/);
    assert.match(reviewInstructions({ prs: ["a", "b"], author: "Ada", user: "Taylan", round: 2 }), /pull requests[\s\S]*This is round 2/);
    assert.match(fixInstructions({ reviewer: "Linus", model: "Codex (gpt-6-astra)", user: "Taylan" }), /pennyworth pr[\s\S]*not Taylan's word[\s\S]*pennyworth ask/);
  });

  it("quotes the findings for the author, and closes each way in plain words", () => {
    const c = findingsComment({ reviewer: "Linus", model: "Codex (gpt-6-astra)", round: 1, reply: "Bug in a.ts:3\n<!-- x -->\n\nVERDICT: blocking", author: "Ada" });
    assert.match(c, /^\*\*Linus reviewed the PR on Codex \(gpt-6-astra\) \(round 1\) and found blocking issues\*\*: passed to Ada\.\n\n> Bug in a\.ts:3\n> \n> VERDICT: blocking\n\n<!-- pennyworth-event -->$/);
    assert.match(closingComment({ outcome: "clean", reviewer: "Linus", model: "M", round: 2 }), /no blocking findings\.\*\* The PR stays a draft/);
    assert.match(closingComment({ outcome: "capped", reviewer: "Linus", rounds: 3, author: "Ada" }), /^3 rounds of review and fixes/);
    assert.match(closingComment({ outcome: "failed", reviewer: "Linus", tried: ["A", "B"], author: "Ada" }), /tried A, B/);
  });
});
