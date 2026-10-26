import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advance, ciState, findPrs, mergeMethod, newQueue, prDecision, startOrResume, WRITES } from "../src/merges.mjs";

const green = { state: "SUCCESS", contexts: { nodes: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" }] } };
const red = { state: "FAILURE", contexts: { nodes: [{ __typename: "StatusContext", context: "buildkite/deploy", state: "FAILURE" }] } };
const pending = { state: "PENDING", contexts: { nodes: [{ __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null }] } };

function pr(number, over = {}) {
  return {
    id: `PR_${number}`, number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, state: "OPEN", isDraft: false, reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN", headRefOid: `head${number}`, baseRefName: "master", latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }] },
    commits: { nodes: [{ commit: { statusCheckRollup: green } }] }, baseRef: { target: { oid: "base", statusCheckRollup: green } }, ...over,
  };
}

/** A fake GitHub: PRs by number, merge commits' rollups by oid, and a log of writes. */
function fakeGithub(prs, commits = {}) {
  const writes = [];
  return {
    writes,
    commits,
    async pr(repo, number) {
      return { repository: { squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, pullRequest: prs[number] } };
    },
    async commit(repo, oid) {
      return { statusCheckRollup: commits[oid] ?? null };
    },
    async merge(repo, number, opts) {
      writes.push({ merge: number, ...opts });
      prs[number] = { ...prs[number], state: "MERGED" };
      return `merge${number}`;
    },
    async updateBranch(repo, number, head) {
      writes.push({ update: number, head });
    },
    async markReady(id) {
      writes.push({ ready: id });
      const n = Number(id.slice(3));
      prs[n] = { ...prs[n], isDraft: false };
    },
  };
}

const at = (min) => new Date(Date.parse("2026-10-26T15:00:00Z") + min * 60_000);

describe("merge queue: reading the PRs", () => {
  it("finds PR links and org/repo#n in order, once each", () => {
    const text = "Trails: https://github.com/0xsequence/devops/pull/4895\nGuard: <https://github.com/0xsequence/devops/pull/4884>\nagain https://github.com/0xsequence/devops/pull/4895 and 0xPolygon/x#7, not #8";
    assert.deepEqual(findPrs(text).map((p) => `${p.repo}#${p.number}`), ["0xsequence/devops#4895", "0xsequence/devops#4884", "0xPolygon/x#7"]);
  });

  it("starts fresh, resumes a stopped queue, and keeps what's merged when new PRs come", () => {
    const q = newQueue(findPrs("o/r#1 o/r#2"), { gapMinutes: 15, now: at(0) });
    q.prs[0].status = "merged";
    q.state = "stopped";
    const resumed = startOrResume(q, [], {});
    assert.equal(resumed.state, "running");
    assert.equal(resumed.gapMinutes, 15);
    const replaced = startOrResume(q, findPrs("o/r#1 o/r#3"), {});
    assert.deepEqual(replaced.prs.map((p) => [p.number, p.status]), [[1, "merged"], [3, "pending"]]);
    assert.equal(startOrResume({ ...q, prs: [q.prs[0]] }, [], {}), undefined); // nothing left to resume
  });
});

describe("merge queue: deciding", () => {
  it("merges only approved, green, clean PRs onto a green base", () => {
    assert.equal(prDecision(pr(1)).do, "merge");
    assert.equal(prDecision(pr(1, { reviewDecision: "REVIEW_REQUIRED" })).do, "stop");
    assert.equal(prDecision(pr(1, { reviewDecision: "CHANGES_REQUESTED" })).do, "stop");
    assert.equal(prDecision(pr(1, { isDraft: true })).do, "ready");
    assert.equal(prDecision(pr(1, { isDraft: true, reviewDecision: "REVIEW_REQUIRED" })).do, "stop");
    assert.equal(prDecision(pr(1, { state: "CLOSED" })).do, "stop");
    assert.equal(prDecision(pr(1, { state: "MERGED" })).do, "skip");
    assert.equal(prDecision(pr(1, { mergeStateStatus: "DIRTY" })).do, "stop");
    assert.equal(prDecision(pr(1, { mergeStateStatus: "UNKNOWN" })).do, "wait");
    assert.equal(prDecision(pr(1, { commits: { nodes: [{ commit: { statusCheckRollup: red } }] } })).do, "stop");
    assert.equal(prDecision(pr(1, { mergeStateStatus: "BLOCKED", commits: { nodes: [{ commit: { statusCheckRollup: pending } }] } })).do, "wait");
    assert.equal(prDecision(pr(1, { mergeStateStatus: "BLOCKED" })).do, "stop");
    assert.equal(prDecision(pr(1, { baseRef: { target: { statusCheckRollup: red } } })).do, "stop");
    assert.equal(prDecision(pr(1, { baseRef: { target: { statusCheckRollup: pending } } })).do, "wait");
  });

  it("without required reviews, needs an approval and no change requests", () => {
    assert.equal(prDecision(pr(1, { reviewDecision: null })).do, "merge");
    assert.equal(prDecision(pr(1, { reviewDecision: null, latestOpinionatedReviews: { nodes: [] } })).do, "stop");
    assert.equal(prDecision(pr(1, { reviewDecision: null, latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }, { state: "CHANGES_REQUESTED" }] } })).do, "stop");
  });

  it("updates a branch that's behind once per head", () => {
    assert.equal(prDecision(pr(1, { mergeStateStatus: "BEHIND" })).do, "update");
    assert.equal(prDecision(pr(1, { mergeStateStatus: "BEHIND" }), { updatedHead: "head1" }).do, "wait");
  });

  it("reads CI and merge methods", () => {
    assert.equal(ciState(null), "green");
    assert.equal(ciState(green), "green");
    assert.equal(ciState(red), "red");
    assert.equal(ciState(pending), "pending");
    assert.equal(mergeMethod({ squashMergeAllowed: false, mergeCommitAllowed: true }), "merge");
    assert.equal(mergeMethod({}), undefined);
  });

  it("writes only merges and branch updates", () => {
    assert.deepEqual(WRITES.map((w) => w.method), ["PUT", "PUT"]);
    assert.ok(WRITES.some((w) => w.path.test("repos/o/r/pulls/1/merge")));
    assert.ok(!WRITES.some((w) => w.path.test("repos/o/r/pulls/1/reviews")));
    assert.ok(!WRITES.some((w) => w.path.test("repos/o/r/git/refs/heads/master")));
  });
});

describe("merge queue: a run through", () => {
  it("merges one at a time, waits for CI and the gap, then finishes", async () => {
    const gh = fakeGithub({ 1: pr(1), 2: pr(2) });
    let q = newQueue(findPrs("o/r#1 o/r#2"), { gapMinutes: 15, now: at(0) });
    let step = await advance(q, { github: gh, now: at(0) });
    assert.deepEqual(gh.writes, [{ merge: 1, sha: "head1", method: "squash" }]);
    assert.equal(step.queue.prs[0].status, "merged");

    gh.commits.merge1 = pending;
    step = await advance(q, { github: gh, now: at(3) });
    assert.equal(step.say.length, 0);
    gh.commits.merge1 = green;
    step = await advance(q, { github: gh, now: at(6) });
    assert.match(step.say[0], /Merged https:\/\/github.com\/o\/r\/pull\/1 \(1 of 2\) and `master` is green/);
    assert.equal(gh.writes.length, 1); // the gap isn't over

    step = await advance(q, { github: gh, now: at(14) });
    assert.equal(gh.writes.length, 1);
    step = await advance(q, { github: gh, now: at(15) });
    assert.deepEqual(gh.writes.at(-1), { merge: 2, sha: "head2", method: "squash" });

    gh.commits.merge2 = green;
    step = await advance(q, { github: gh, now: at(21) });
    assert.equal(step.done, "done");
    assert.equal(step.queue.state, "done");
    assert.match(step.say.at(-1), /\*\*Done:\*\*/);
  });

  it("stops when CI goes red after a merge, and doesn't merge the next one", async () => {
    const gh = fakeGithub({ 1: pr(1), 2: pr(2) }, { merge1: red });
    const q = newQueue(findPrs("o/r#1 o/r#2"), { gapMinutes: 0, now: at(0) });
    await advance(q, { github: gh, now: at(0) });
    const step = await advance(q, { github: gh, now: at(2) });
    assert.equal(step.done, "stopped");
    assert.match(step.say[0], /CI failed on `master` after merging #1: buildkite\/deploy/);
    assert.match(step.say[0], /continue from #2/);
    assert.equal(gh.writes.length, 1);
    assert.deepEqual(await advance(q, { github: gh, now: at(30) }), { queue: q, say: [] }); // stays stopped
  });

  it("skips a PR someone else merged and stops on one that isn't approved", async () => {
    const gh = fakeGithub({ 1: pr(1, { state: "MERGED", mergedBy: { login: "alice" } }), 2: pr(2, { reviewDecision: "REVIEW_REQUIRED" }) });
    const q = newQueue(findPrs("o/r#1 o/r#2"), { gapMinutes: 15, now: at(0) });
    const step = await advance(q, { github: gh, now: at(0) });
    assert.match(step.say[0], /Skipped https:\/\/github.com\/o\/r\/pull\/1: #1 was already merged by alice/);
    assert.equal(step.done, "stopped");
    assert.match(step.say.at(-1), /#2 isn't approved/);
    assert.equal(gh.writes.length, 0);
  });

  it("marks an approved draft ready, then merges it", async () => {
    const gh = fakeGithub({ 1: pr(1, { isDraft: true }) });
    const q = newQueue(findPrs("o/r#1"), { gapMinutes: 15, now: at(0) });
    await advance(q, { github: gh, now: at(0) });
    assert.deepEqual(gh.writes, [{ ready: "PR_1" }]);
    await advance(q, { github: gh, now: at(1) });
    assert.deepEqual(gh.writes.at(-1), { merge: 1, sha: "head1", method: "squash" });
  });

  it("gives up on a PR whose checks never finish", async () => {
    const gh = fakeGithub({ 1: pr(1, { commits: { nodes: [{ commit: { statusCheckRollup: pending } }] } }) });
    const q = newQueue(findPrs("o/r#1"), { gapMinutes: 15, now: at(0) });
    assert.equal((await advance(q, { github: gh, now: at(0), timeoutMinutes: 30 })).done, undefined);
    assert.equal((await advance(q, { github: gh, now: at(20), timeoutMinutes: 30 })).done, undefined);
    const step = await advance(q, { github: gh, now: at(31), timeoutMinutes: 30 });
    assert.equal(step.done, "stopped");
    assert.match(step.queue.reason, /stuck for 30 minutes: #1's checks are running/);
  });

  it("stops with GitHub's words when a merge is refused", async () => {
    const gh = fakeGithub({ 1: pr(1) });
    gh.merge = async () => {
      throw Object.assign(new Error("failed"), { stderr: "gh: Head branch was modified. Review and try the merge again. (HTTP 409)" });
    };
    const step = await advance(newQueue(findPrs("o/r#1"), { gapMinutes: 15, now: at(0) }), { github: gh, now: at(0) });
    assert.match(step.queue.reason, /GitHub refused to merge #1: .*Head branch was modified/);
  });
});
