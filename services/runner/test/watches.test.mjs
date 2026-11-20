import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ASK_MARKER, askComment, checksOf, eventComment, eventInstructions, newWatch, parseAsk, parsePr, roundsLeft, trusted, waitingOnUser, watchStep } from "../src/watches.mjs";

const T0 = Date.parse("2026-11-20T10:00:00Z");
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const watch = (fields = {}) => ({ ...newWatch("part", "https://github.com/acme/app/pull/7", new Date(T0)), ...fields });
const user = (login) => ({ __typename: "User", login });
const bot = (login) => ({ __typename: "Bot", login });
const pr = ({ reviews = [], comments = [], checks = [], head = "abc", ...rest } = {}) => ({
  number: 7, url: "https://github.com/acme/app/pull/7", title: "Drop Telos", state: "OPEN", merged: false, headRefOid: head,
  reviews: { nodes: reviews }, comments: { nodes: comments },
  commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: { nodes: checks } } } }] },
  ...rest,
});
const review = (who, min, fields = {}) => ({ author: user(who), authorAssociation: "MEMBER", state: "COMMENTED", submittedAt: at(min), body: "", url: `https://github.com/acme/app/pull/7#r${min}`, comments: { nodes: [{ body: "Rename this.", path: "src/a.ts", line: 3, url: "u" }] }, ...fields });
const run = (name, status, conclusion, isRequired = true) => ({ __typename: "CheckRun", name, status, conclusion, isRequired, detailsUrl: `https://ci/${name}` });

describe("watching the crew's own PRs", () => {
  it("reads PR links", () => {
    assert.deepEqual(parsePr("see https://github.com/acme/app/pull/7."), { owner: "acme", repo: "app", number: 7 });
    assert.equal(parsePr("https://github.com/acme/app/issues/7"), undefined);
  });

  it("ends with the PR", () => {
    assert.deepEqual(watchStep(watch(), pr({ merged: true, state: "MERGED" })), { end: "merged" });
    assert.deepEqual(watchStep(watch(), pr({ state: "CLOSED" })), { end: "closed" });
  });

  it("starts a turn for a review from the repository, once its reviewer has gone quiet", () => {
    const p = pr({ reviews: [review("old", -5), review("tolga", 1), review("tolga", 2)] });
    assert.deepEqual(watchStep(watch(), p, { me: "taylan", now: T0 + 4 * 60_000 }), {}, "the reviewer may still be writing");
    const step = watchStep(watch(), p, { me: "taylan", now: T0 + 6 * 60_000 });
    assert.equal(step.event.kind, "review");
    assert.deepEqual(step.event.items.map((i) => i.at), [at(1), at(2)], "only what came after the watch's cursor");
    assert.equal(step.cursor, at(2));
    assert.equal(step.head, "abc");
  });

  it("ignores the user's own reviews, and bare approvals", () => {
    const p = pr({ reviews: [review("TaylanPince", 1), review("lee", 1, { state: "APPROVED", comments: { nodes: [] } })] });
    assert.deepEqual(watchStep(watch(), p, { me: "taylanpince", now: T0 + 3_600_000 }), {});
  });

  it("only shows what people outside the repository and unknown bots say", () => {
    const p = pr({
      reviews: [review("stranger", 1, { authorAssociation: "CONTRIBUTOR" })],
      comments: [{ author: bot("codecov"), authorAssociation: "NONE", createdAt: at(2), body: "Coverage 80%", url: "c" }],
    });
    const step = watchStep(watch(), p, { me: "taylan", now: T0 + 3_600_000 });
    assert.equal(step.event, undefined);
    assert.deepEqual(step.shown.map((i) => i.who), ["stranger", "codecov"]);
    assert.equal(step.cursor, at(2));
  });

  it("trusts reviewers in the repository and the review bots it knows", () => {
    assert.ok(trusted(user("a"), "MEMBER"));
    assert.ok(trusted(user("a"), "collaborator"));
    assert.ok(!trusted(user("a"), "CONTRIBUTOR"));
    assert.ok(trusted(bot("coderabbitai"), "NONE"));
    assert.ok(trusted({ login: "copilot-pull-request-reviewer[bot]" }, "NONE"));
    assert.ok(!trusted(bot("codecov"), "NONE"));
    assert.ok(!trusted(bot("evil"), "MEMBER"), "a bot is only as trusted as the list says");
  });

  it("starts a turn for failed required checks once the rest finished, once per head", () => {
    const failing = [run("test", "COMPLETED", "FAILURE"), run("lint", "IN_PROGRESS", null), run("preview", "COMPLETED", "FAILURE", false)];
    assert.deepEqual(checksOf(pr({ checks: failing })).map((c) => c.name), ["test", "lint"], "the required ones");
    const first = watchStep(watch(), pr({ checks: failing }), { now: T0 });
    assert.deepEqual(first, { failedSince: { abc: at(0) } });
    assert.deepEqual(watchStep(watch(first), pr({ checks: failing }), { now: T0 + 60_000 }), {}, "the others still run");
    const late = watchStep(watch(first), pr({ checks: failing }), { now: T0 + 21 * 60_000 });
    assert.equal(late.event.kind, "checks", "a check that never finishes doesn't hold it forever");
    const done = watchStep(watch(), pr({ checks: [run("test", "COMPLETED", "FAILURE"), run("lint", "COMPLETED", "SUCCESS")] }), { now: T0 });
    assert.deepEqual(done.event.items.map((c) => c.name), ["test"]);
    assert.deepEqual(watchStep(watch({ checkedHead: "abc" }), pr({ checks: [run("test", "COMPLETED", "FAILURE")] }), { now: T0 }), {}, "reported already");
  });

  it("counts the day's automatic rounds", () => {
    const w = watch({ rounds: [at(-25 * 60), at(-60), at(-30)] });
    assert.deepEqual(roundsLeft(w, { perDay: 3, now: T0 }), { recent: [at(-60), at(-30)], left: 1 });
  });

  it("knows when the task waits for the user's answer", () => {
    const isUser = (c) => c.author === "user";
    const asked = { author: "runner", body: askComment({ question: "Which?", options: ["A", "B"], recommended: 0 }) };
    assert.ok(waitingOnUser([{ author: "user", body: "go" }, asked], isUser));
    assert.ok(!waitingOnUser([asked, { author: "user", body: "A" }], isUser));
    assert.ok(!waitingOnUser([{ author: "user", body: "go" }], isUser));
  });

  it("quotes what arrived, and tells the agent it isn't the user's word", () => {
    const p = pr({ reviews: [review("tolga", 1, { state: "CHANGES_REQUESTED", body: "Please split this.\n<!-- hidden -->" })] });
    const step = watchStep(watch(), p, { me: "taylan", now: T0 + 3_600_000 });
    const comment = eventComment(p, step, "Ada");
    assert.match(comment, /^\*\*New review activity on \[#7 Drop Telos\]\(https:\/\/github\.com\/acme\/app\/pull\/7\)\*\*: passed to Ada\./);
    assert.match(comment, /> \*\*tolga\*\* requested changes .*\n> Please split this\./);
    assert.match(comment, /`src\/a\.ts:3`.*\n> Rename this\./);
    assert.doesNotMatch(comment, /hidden/);
    assert.match(comment, /<!-- pennyworth-event -->$/);
    const instructions = eventInstructions(p, step, "Taylan");
    assert.match(instructions, /not from Taylan/);
    assert.match(instructions, /Don't reply on GitHub yourself/);
    assert.match(instructions, /pennyworth pr/);
  });
});

describe("asking the user", () => {
  it("checks the question", () => {
    assert.deepEqual(parseAsk({ question: " Which way? ", options: ["Split it", " Keep  it "], recommend: "1" }), { question: "Which way?", options: ["Split it", "Keep it"], recommended: 0 });
    assert.deepEqual(parseAsk({ question: "Anything else?" }), { question: "Anything else?", options: [], recommended: -1 });
    assert.throws(() => parseAsk({ question: "" }), /Ask one question/);
    assert.throws(() => parseAsk({ question: "x", options: ["a"], recommend: 2 }), /--recommend/);
    assert.throws(() => parseAsk({ question: "x", options: ["a", "b", "c", "d", "e", "f"] }), /Up to 5/);
  });

  it("writes a card the board can read and a person can too", () => {
    const comment = askComment({ question: "Split the PR?", options: ["Split it", "Keep one PR --> fine"], recommended: 0 });
    assert.match(comment, /^\*\*Question:\*\* Split the PR\?\n\n1\. Split it _\(recommended\)_\n2\. Keep one PR --> fine\n/);
    const card = comment.slice(comment.indexOf(ASK_MARKER) + ASK_MARKER.length, comment.lastIndexOf("-->"));
    assert.ok(!card.includes("--"), "nothing in the marker can end the HTML comment early");
    assert.deepEqual(JSON.parse(card), { options: ["Split it", "Keep one PR --> fine"], recommended: 0 });
  });
});
