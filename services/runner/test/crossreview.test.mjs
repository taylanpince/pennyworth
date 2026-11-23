import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { closingComment, declined, refusedByPolicy, findingsComment, fixInstructions, pairPanel, panelComment, repoMode, reviewInstructions, reviewPanel, reviewVerdict, roundOutcome, roundSlots } from "../src/crossreview.mjs";

describe("cross-model review", () => {
  it("reviews on two models at once by default, never with the author's family", () => {
    assert.deepEqual(reviewPanel("claude"), [
      [{ kind: "codex", model: "gpt-6-astra" }, { kind: "openrouter", model: "moonshotai/kimi-k3" }],
      [{ kind: "openrouter", model: "deepseek/deepseek-v4.1-flash" }, { kind: "openrouter", model: "z-ai/glm-5.3" }],
    ]);
    for (const kind of ["claude", "codex", "openrouter"]) {
      assert.equal(reviewPanel(kind).length, 2);
      assert.ok(reviewPanel(kind).flat().every((e) => e.kind !== kind), kind);
    }
    assert.equal(reviewPanel("codex").at(-1)[0].kind, "openrouter", "the cheap reviewer is last: a light round takes it");
    assert.deepEqual(reviewPanel("cad"), []);
  });

  it("takes configured panels as written, and a chain from before panels as one reviewer", () => {
    const chains = { claude: [{ engine: "openrouter", model: "openrouter/z-ai/glm-5.3" }, { engine: "claude", model: "claude-sonnet-5", effort: "high" }, { engine: "nope" }] };
    assert.deepEqual(reviewPanel("claude", { chains }), [[{ kind: "openrouter", model: "z-ai/glm-5.3" }, { kind: "claude", model: "claude-sonnet-5", effort: "high" }]]);
    assert.deepEqual(reviewPanel("codex", { chains }), reviewPanel("codex"), "other engines keep the defaults");
    const panels = { claude: [[{ engine: "codex", model: "gpt-6-sol" }], [{ engine: "nope" }], [{ engine: "openrouter", model: "moonshotai/kimi-k3" }]] };
    assert.deepEqual(reviewPanel("claude", { panels, chains }), [[{ kind: "codex", model: "gpt-6-sol" }], [{ kind: "openrouter", model: "moonshotai/kimi-k3" }]], "panels win, and an empty reviewer is dropped");
  });

  it("reviews config repositories lightly, or not at all, as configured", () => {
    const repos = { "0xsequence/devops": "light", "acme/infra": "skip", "acme/odd": "detailed" };
    assert.equal(repoMode("https://github.com/0xsequence/devops/pull/5002", repos), "light");
    assert.equal(repoMode("https://github.com/0xSequence/DevOps/pull/1", repos), "light", "GitHub names ignore case");
    assert.equal(repoMode("https://github.com/acme/infra/pull/1", repos), "skip");
    assert.equal(repoMode("https://github.com/acme/odd/pull/1", repos), "full", "an unknown mode is a full review");
    assert.equal(repoMode("https://github.com/0xsequence/stack/pull/1345", repos), "full");
    assert.equal(repoMode("https://github.com/0xsequence/devops/pull/1"), "full");
    const panel = reviewPanel("claude");
    assert.deepEqual(roundSlots(panel, ["full", "light"]), [0, 1]);
    assert.deepEqual(roundSlots(panel, ["light", "light"]), [1], "a light round is the cheap reviewer alone");
    assert.deepEqual(roundSlots(panel, ["skip"]), []);
    assert.deepEqual(roundSlots([], ["full"]), []);
  });

  it("decides a round from both reviewers: blocking from either is blocking", () => {
    const clean = { model: "A", verdict: "clean" };
    const blocking = { model: "B", verdict: "blocking" };
    const silent = { model: "C" };
    const failed = { failed: true, tried: ["D", "E"] };
    assert.equal(roundOutcome([clean, blocking]), "blocking");
    assert.equal(roundOutcome([failed, blocking]), "blocking");
    assert.equal(roundOutcome([clean, failed]), "clean");
    assert.equal(roundOutcome([silent, failed]), "unclear");
    assert.equal(roundOutcome([failed, failed]), "failed");
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
    assert.match(first, /failing test or a small probe/);
    assert.match(reviewInstructions({ prs: ["a", "b"], author: "Ada", user: "Taylan", round: 2 }), /pull requests[\s\S]*This is round 2/);
    const light = reviewInstructions({ prs: [], light: ["https://github.com/0xsequence/devops/pull/9"], author: "Ada", user: "Taylan", round: 1 });
    assert.match(light, /It's a configuration change posted for another team to approve, not for a detailed review: check only what would break the deploy/);
    assert.doesNotMatch(light, /missing or wrong tests|probe/);
    const mixed = reviewInstructions({ prs: ["https://github.com/acme/app/pull/1"], light: ["https://github.com/0xsequence/devops/pull/9"], author: "Ada", user: "Taylan", round: 1 });
    assert.match(mixed, /^Review Ada's pull requests[\s\S]*- https:\/\/github\.com\/acme\/app\/pull\/1\n\nRead each[\s\S]*missing or wrong tests[\s\S]*for them, check only what would break the deploy[\s\S]*- https:\/\/github\.com\/0xsequence\/devops\/pull\/9/);
    assert.match(fixInstructions({ reviewer: "Linus", model: "Codex (gpt-6-astra)", user: "Taylan" }), /pennyworth pr[\s\S]*not Taylan's word[\s\S]*pennyworth ask/);
  });

  it("quotes the findings for the author, and closes each way in plain words", () => {
    const c = findingsComment({ reviewer: "Linus", reviews: [{ model: "Codex (gpt-6-astra)", reply: "Bug in a.ts:3\n<!-- x -->\n\nVERDICT: blocking" }], round: 1, author: "Ada" });
    assert.match(c, /^\*\*Linus reviewed the PR on Codex \(gpt-6-astra\) \(round 1\) and found blocking issues\*\*: passed to Ada\.\n\n> Bug in a\.ts:3\n> \n> VERDICT: blocking\n\n<!-- pennyworth-event -->$/);
    const both = findingsComment({ reviewer: "Linus", reviews: [{ model: "A", reply: "x\n\nVERDICT: blocking" }, { model: "B", reply: "y\n\nVERDICT: blocking" }], round: 2, author: "Ada" });
    assert.match(both, /^\*\*Linus reviewed the PR on A and B \(round 2\) and found blocking issues\*\*: passed to Ada\.\n\n\*\*On A:\*\*\n\n> x\n> \n> VERDICT: blocking\n\n\*\*On B:\*\*\n\n> y/);
    assert.match(closingComment({ outcome: "clean", reviewer: "Linus", results: [{ model: "M", verdict: "clean" }, { model: "N", verdict: "clean" }], round: 2 }), /on M and N \(round 2\): no blocking findings\.\*\* The PR stays a draft/);
    assert.match(closingComment({ outcome: "clean", reviewer: "Linus", results: [{ model: "M", verdict: "clean" }, { failed: true, tried: ["A", "B"] }], round: 1 }), /on M \(round 1\): no blocking findings\.\*\* Note: no model could take the other review \(tried A, B\)\. The PR stays/);
    assert.match(closingComment({ outcome: "capped", reviewer: "Linus", rounds: 3, author: "Ada" }), /^3 rounds of review and fixes/);
    assert.match(closingComment({ outcome: "failed", reviewer: "Linus", results: [{ failed: true, tried: ["A", "B"] }, { failed: true, tried: ["C"] }], author: "Ada" }), /tried A, B, C/);
  });

  it("asks for a review the user wanted without a crew author, with the user's request", () => {
    const asked = reviewInstructions({ prs: ["https://github.com/acme/app/pull/7"], user: "Taylan", round: 1, request: "Review this.\nFocus on the migration." });
    assert.match(asked, /^Review the pull request adversarially, as a second engineer on another model:\n\n- https:\/\/github\.com\/acme\/app\/pull\/7\n\nTaylan asked for this review:\n\n> Review this\.\n> Focus on the migration\.\n\nRead it/);
    assert.match(asked, /your findings go on this task, where Taylan reads them\./);
    assert.doesNotMatch(asked, /undefined/);
    assert.match(reviewInstructions({ prs: ["a"], user: "Taylan", round: 2 }), /This is round 2: your earlier review is in the conversation\. Review what changed since/);
  });

  it("reviews on the pair picked for Linus, each falling back to a model outside the pair (D-80)", () => {
    const kimi = { kind: "openrouter", model: "moonshotai/kimi-k3" };
    const glm = { kind: "openrouter", model: "z-ai/glm-5.3" };
    const deepseek = { kind: "openrouter", model: "deepseek/deepseek-v4.1-flash" };
    const opus = { kind: "claude", model: "claude-opus-5-5" };
    assert.deepEqual(pairPanel([kimi, deepseek]), [[kimi, glm], [deepseek, glm]]);
    assert.deepEqual(pairPanel([opus, kimi]), [[opus, glm], [kimi, glm]]);
    assert.deepEqual(pairPanel([opus, deepseek]), [[opus, kimi, glm], [deepseek, kimi, glm]]);
    assert.deepEqual(pairPanel([opus, deepseek], [{ engine: "codex", model: "gpt-6-astra" }]), [[opus, { kind: "codex", model: "gpt-6-astra" }], [deepseek, { kind: "codex", model: "gpt-6-astra" }]], "fallbacks from config");
    assert.deepEqual(roundSlots(pairPanel([opus, deepseek]), ["light"]), [1], "a light round takes the second");
  });

  it("brings every review back to the user, blocking first, under each model", () => {
    const c = panelComment({ reviewer: "Linus", results: [{ model: "A", verdict: "clean", reply: "fine\n\nVERDICT: clean" }, { model: "B", verdict: "blocking", reply: "bug\n\nVERDICT: blocking" }], round: 1, poster: "Alfred" });
    assert.match(c, /^\*\*Linus reviewed the PR on B and A\*\*, each model on its own\. Ask Linus here about a finding or to look again; Alfred posts it on GitHub when you say\.\n\n\*\*On B: blocking findings\.\*\*\n\n> bug[\s\S]*\*\*On A: no blocking findings\.\*\*\n\n> fine/);
    assert.match(c, /<!-- pennyworth-event -->$/);
    const one = panelComment({ reviewer: "Linus", results: [{ model: "A", reply: "hm" }, { failed: true, tried: ["X", "Y"] }], round: 2 });
    assert.match(one, /on A \(round 2\)\*\*[\s\S]*On A: no verdict\.[\s\S]*No model could take the other review \(tried X, Y\)/);
    assert.match(panelComment({ reviewer: "Linus", results: [{ failed: true, tried: ["X"] }], round: 1 }), /^No model could review the PR/);
  });
});
