import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { followUpInstructions, parseNote, parseWhen, primerComments, primerEventComment, slackEventComment, slackInstructions, slackReplies, slackThreads, slackTs } from "../src/watches.mjs";

const NOW = new Date(2026, 10, 20, 10, 0);

describe("follow-ups agents set", () => {
  it("reads when, from now", () => {
    assert.equal(parseWhen("2h", NOW).getTime(), NOW.getTime() + 2 * 3_600_000);
    assert.equal(parseWhen("3d", NOW).getTime(), NOW.getTime() + 3 * 86_400_000);
    assert.equal(parseWhen("30m", NOW).getTime(), NOW.getTime() + 30 * 60_000);
    assert.deepEqual(parseWhen("2026-11-25", NOW), new Date(2026, 10, 25, 9, 0), "a date is 09:00 local");
    assert.deepEqual(parseWhen("2026-11-25T14:30", NOW), new Date(2026, 10, 25, 14, 30));
    assert.throws(() => parseWhen("5m", NOW), /at least 10 minutes/);
    assert.throws(() => parseWhen("5w", NOW), /at most 30 days/);
    assert.throws(() => parseWhen("next tuesday", NOW), /Say when/);
    assert.throws(() => parseWhen("2026-11-19", NOW), /at least 10 minutes/, "not in the past");
  });

  it("keeps the note to one line", () => {
    assert.equal(parseNote("  check the\n deploy "), "check the deploy");
    assert.throws(() => parseNote(""), /what to check/);
    assert.throws(() => parseNote("x".repeat(501)), /500/);
    assert.match(followUpInstructions("check the deploy", "Taylan"), /"check the deploy"[\s\S]*not Taylan's word[\s\S]*NO_REPLY/);
  });
});

// The shape Slack's MCP server answers slack_read_thread with (2026-11-20).
const THREAD = `=== THREAD PARENT MESSAGE ===
From: Jeremy Brenner <jbrenner@example.com> (U0A1RSBD9)
Time: 2026-11-19 15:11:39 CET
Message TS: 1795097499.513849
Immediate plan:
• Fund $200 in each asset

=== THREAD REPLIES (3 total) ===

--- Reply 1 of 3 ---
From: Taylan Pince <tpince@example.com> (U0AAVH6044B)
Time: 2026-11-19 19:53:52 CET
Message TS: 1795114432.950939
Looks good.

--- Reply 2 of 3 ---
From: Jeremy Brenner <jbrenner@example.com> (U0A1RSBD9)
Time: 2026-11-19 20:06:12 CET
Message TS: 1795115172.896229
Thanks. We should expect this to be very brittle.
Second line.
Reactions: raised_hands (2)

--- Reply 3 of 3 ---
From: Deploy Bot (B0123)
Time: 2026-11-19 20:07:00 CET
Message TS: 1795115220.000100
Deployed.
`;

describe("the Slack thread a task came from", () => {
  it("reads the replies, not the parent", () => {
    assert.deepEqual(slackReplies(THREAD), [
      { who: "Taylan Pince", user: "U0AAVH6044B", ts: "1795114432.950939", text: "Looks good." },
      { who: "Jeremy Brenner", user: "U0A1RSBD9", ts: "1795115172.896229", text: "Thanks. We should expect this to be very brittle.\nSecond line." },
      { who: "Deploy Bot", user: "B0123", ts: "1795115220.000100", text: "Deployed." },
    ]);
    assert.deepEqual(slackReplies("=== THREAD PARENT MESSAGE ===\nFrom: A (U1)\nMessage TS: 1.2\nHi\n\nNo thread messsages\n"), []);
  });

  it("finds threads in markers and permalinks, once each", () => {
    const text = "<!-- source:slack:C0ACST8M7JT:1793640443.900009 -->\nhttps://0xpolygon.slack.com/archives/C0ACST8M7JT/p1794855087008419?thread_ts=1793640443.900009&cid=C0ACST8M7JT\nhttps://x.slack.com/archives/C1/p1794855087008419\n<!-- source:slack:pin:C2:1.2 -->";
    assert.deepEqual(slackThreads(text), [{ channel: "C0ACST8M7JT", root: "1793640443.900009" }, { channel: "C1", root: "1794855087.008419" }]);
  });

  it("writes Slack time and quotes replies as others' words", () => {
    assert.equal(slackTs(1795115172896), "1795115172.896000");
    const c = slackEventComment("https://slack.com/archives/C1/p1", [{ who: "Jeremy", text: "Use Base first.\nThen Polygon." }], "Ada");
    assert.match(c, /^\*\*New replies in the Slack thread this task came from\*\* \(\[thread\]\(https:\/\/slack\.com\/archives\/C1\/p1\)\): passed to Ada\.\n\n> \*\*Jeremy\*\*\n> Use Base first\.\n> Then Polygon\.\n\n<!-- pennyworth-event -->$/);
    assert.match(slackInstructions("Taylan"), /not Taylan's word[\s\S]*NO_REPLY[\s\S]*Don't reply in Slack/);
  });
});

describe("comments on the task's Primer document", () => {
  // primer_get_document_comments' answer (2026-11-20).
  const answer = JSON.stringify({ documentId: "d1", versions: [
    { versionNumber: 1, markdown: "# Comments on X (v1)\nThreads: 1\n\n> ingress-nginx controller\tchart 4.12.2\n[open]\n**Thiago Nobayashi** — all decommissioned (2026-11-18T19:36:11.555Z)\n" },
    { versionNumber: 2, markdown: "# Comments on X (v2)\n\n> Summary\n[open]\n**Taylan Pince** — tighten this (2026-11-17T10:00:00.000Z)\n**Jeremy Brenner** — agreed — and add costs (2026-11-19T08:00:00.000Z)\n" },
  ] });

  it("reads each comment with its author, time and passage, oldest first", () => {
    assert.deepEqual(primerComments(answer), [
      { who: "Taylan Pince", text: "tighten this", at: "2026-11-17T10:00:00.000Z", on: "Summary", version: 2 },
      { who: "Thiago Nobayashi", text: "all decommissioned", at: "2026-11-18T19:36:11.555Z", on: "ingress-nginx controller\tchart 4.12.2", version: 1 },
      { who: "Jeremy Brenner", text: "agreed — and add costs", at: "2026-11-19T08:00:00.000Z", on: "Summary", version: 2 },
    ]);
    assert.deepEqual(primerComments("not json"), []);
  });

  it("quotes them for the agent", () => {
    const c = primerEventComment("https://primer.example/d/d1", primerComments(answer).slice(2), "Ada");
    assert.match(c, /^\*\*New comments on your Primer document\*\* \(\[open\]\(https:\/\/primer\.example\/d\/d1\)\): passed to Ada\.\n\n> \*\*Jeremy Brenner\*\* on v2, on "Summary"\n> agreed — and add costs\n\n<!-- pennyworth-event -->$/);
  });
});
