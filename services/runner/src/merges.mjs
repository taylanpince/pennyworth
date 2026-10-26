// Merging approved pull requests on the user's word (D-46): the PRs a task names, one at a time,
// a set gap apart, with CI on the base branch watched after each merge. Code decides everything:
// a PR is merged only when it is open, approved, its checks are green, GitHub says it can merge and
// the base branch is green. An approved draft is marked ready first: asking for it to be merged says
// it's ready. Anything else stops the queue with a comment; nothing is ever forced, reverted or merged
// as an admin. The only GitHub writes here are WRITES and READY_MUTATION below.

/** Pull requests named in free text, in order: links, or org/repo#n. Duplicates dropped. */
export function findPrs(text) {
  const out = [];
  const re = /(?:https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+))|(?<![\w./-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/g;
  for (const m of String(text ?? "").replace(/\\(.)/g, "$1").matchAll(re)) {
    const [org, name, number] = m[1] ? [m[1], m[2], m[3]] : [m[4], m[5], m[6]];
    const repo = `${org}/${name}`;
    if (!out.some((p) => p.repo.toLowerCase() === repo.toLowerCase() && p.number === Number(number))) out.push({ repo, number: Number(number), url: `https://github.com/${repo}/pull/${number}` });
  }
  return out;
}

/** A new queue for the PRs, merged in the order given. */
export function newQueue(prs, { gapMinutes, now = new Date() }) {
  return { state: "running", gapMinutes, startedAt: now.toISOString(), prs: prs.map((p) => ({ ...p, status: "pending" })) };
}

export const PR_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed
    pullRequest(number: $number) {
      id number title url state isDraft reviewDecision mergeStateStatus headRefOid baseRefName
      mergedAt mergedBy { login } mergeCommit { oid }
      latestOpinionatedReviews(first: 30) { nodes { state } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
      baseRef { target { oid ... on Commit { statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
    }
  }
}`;

export const COMMIT_QUERY = `query($owner: String!, $repo: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $repo) {
    object(oid: $oid) { ... on Commit { committedDate statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } }
  }
}`;

/** Marks a draft ready for review: the one GraphQL write. */
export const READY_MUTATION = `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`;

/** The REST writes this module makes, and nothing else. */
export const WRITES = [
  { method: "PUT", path: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/merge$/ },
  { method: "PUT", path: /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/update-branch$/ },
];

/** Names of the checks that failed in a status rollup. */
export function failedChecks(rollup) {
  const bad = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
  return (rollup?.contexts?.nodes ?? []).filter((n) => bad.has(n.conclusion ?? n.state)).map((n) => n.name ?? n.context);
}

/** "green", "red" or "pending" for a status rollup. No checks at all counts as green. */
export function ciState(rollup) {
  if (!rollup) return "green";
  if (rollup.state === "SUCCESS") return "green";
  if (rollup.state === "FAILURE" || rollup.state === "ERROR") return "red";
  return "pending";
}

/** The merge method: the repository's only allowed one, else squash, then merge commit, then rebase. */
export function mergeMethod(repo) {
  if (repo.squashMergeAllowed) return "squash";
  if (repo.mergeCommitAllowed) return "merge";
  if (repo.rebaseMergeAllowed) return "rebase";
  return undefined;
}

/** Approved: GitHub's review decision, or (where reviews aren't required) an approval and no change requests. */
export function approved(pr) {
  if (pr.reviewDecision) return pr.reviewDecision === "APPROVED";
  const states = (pr.latestOpinionatedReviews?.nodes ?? []).map((r) => r.state);
  return states.includes("APPROVED") && !states.includes("CHANGES_REQUESTED");
}

/**
 * What to do with the next PR, from GitHub's view of it: { do: "merge" | "ready" | "update" | "wait" | "skip" | "stop", why }.
 * `updatedHead` is the head we already asked GitHub to update (so a branch is updated once per head).
 */
export function prDecision(pr, { updatedHead } = {}) {
  const ref = `#${pr.number}`;
  if (pr.state === "MERGED") return { do: "skip", why: `${ref} was already merged${pr.mergedBy?.login ? ` by ${pr.mergedBy.login}` : ""}` };
  if (pr.state === "CLOSED") return { do: "stop", why: `${ref} is closed` };
  if (!approved(pr)) return { do: "stop", why: `${ref} isn't approved${pr.reviewDecision ? ` (GitHub: ${pr.reviewDecision.toLowerCase().replace(/_/g, " ")})` : ""}` };
  if (pr.isDraft) return { do: "ready", why: `${ref} is an approved draft` };
  const checks = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const ci = ciState(checks);
  if (ci === "red") return { do: "stop", why: `${ref} has failing checks: ${failedChecks(checks).join(", ") || "see the PR"}` };
  switch (pr.mergeStateStatus) {
    case "DIRTY":
      return { do: "stop", why: `${ref} has conflicts with \`${pr.baseRefName}\`` };
    case "BEHIND":
      return pr.headRefOid === updatedHead ? { do: "wait", why: `${ref} is being updated with \`${pr.baseRefName}\`` } : { do: "update", why: `${ref} is behind \`${pr.baseRefName}\`` };
    case "UNSTABLE":
      return ci === "pending" ? { do: "wait", why: `${ref}'s checks are running` } : { do: "stop", why: `${ref} has failing checks` };
    case "BLOCKED":
      return ci === "pending" ? { do: "wait", why: `${ref}'s checks are running` } : { do: "stop", why: `GitHub won't merge ${ref} yet (blocked by a branch rule)` };
    case "CLEAN":
    case "HAS_HOOKS":
      break;
    default: // UNKNOWN: GitHub is still working it out
      return { do: "wait", why: `GitHub is still checking whether ${ref} can merge` };
  }
  if (ci === "pending") return { do: "wait", why: `${ref}'s checks are running` };
  const base = ciState(pr.baseRef?.target?.statusCheckRollup);
  if (base === "red") return { do: "stop", why: `\`${pr.baseRefName}\` is red before merging ${ref}: ${failedChecks(pr.baseRef.target.statusCheckRollup).join(", ")}` };
  if (base === "pending") return { do: "wait", why: `CI is running on \`${pr.baseRefName}\`` };
  return { do: "merge" };
}

const minutes = (ms) => Math.round(ms / 60_000);
/** Local time on this host (the user's), e.g. "14:05". */
const clock = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * Move a running queue on by one poll. `github` does the I/O: pr(repo, number), commit(repo, oid),
 * merge(repo, number, { sha, method }) → merge commit oid, markReady(prNodeId), updateBranch(repo, number, head).
 * Mutates and returns the queue; `say` collects comments for the task, `done` is set when it ends.
 */
export async function advance(queue, { github, now = new Date(), timeoutMinutes = 90, settleMinutes = 5 }) {
  const say = [];
  if (queue.state !== "running") return { queue, say };
  const t = now.getTime();
  const total = queue.prs.length;
  const stop = (why) => {
    queue.state = "stopped";
    queue.stoppedAt = now.toISOString();
    queue.reason = why;
    return { queue, say: [...say, stoppedComment(queue)], done: "stopped" };
  };
  const waiting = (key, why) => {
    queue.wait ??= { key, since: now.toISOString() };
    if (queue.wait.key !== key) queue.wait = { key, since: now.toISOString() };
    queue.waiting = why;
    if (t - Date.parse(queue.wait.since) > timeoutMinutes * 60_000) return stop(`stuck for ${timeoutMinutes} minutes: ${why}`);
    return { queue, say };
  };

  // 1. The last merge: its CI on the base branch must finish green.
  const last = queue.prs.filter((p) => p.status === "merged" && p.sha).at(-1);
  if (last && !last.ciAt) {
    const commit = await github.commit(last.repo, last.sha);
    const rollup = commit?.statusCheckRollup;
    const ci = ciState(rollup);
    // Checks show up a little after the merge: no checks yet is only green after a short settle.
    const settled = t - Date.parse(last.mergedAt) >= settleMinutes * 60_000;
    if (ci === "red") return stop(`CI failed on \`${last.base}\` after merging #${last.number}: ${failedChecks(rollup).join(", ") || "see the commit"}`);
    if (ci === "pending" || !settled) return waiting(`ci:${last.sha}`, `CI is running on \`${last.base}\` after #${last.number}`);
    last.ciAt = now.toISOString();
    last.checks = rollup?.contexts?.nodes?.length ?? 0;
    const merged = queue.prs.filter((p) => p.status === "merged").length;
    const next = queue.prs.find((p) => p.status === "pending");
    const nextAt = new Date(Math.max(Date.parse(last.mergedAt) + queue.gapMinutes * 60_000, t)).toISOString();
    say.push(
      `Merged ${last.url} (${merged} of ${total}) and \`${last.base}\` is green${last.checks ? ` (${last.checks} checks)` : ""}.${next ? ` Next: #${next.number}${queue.gapMinutes && Date.parse(nextAt) > t ? ` after ${clock(nextAt)}` : ""}.` : ""}`,
    );
  }

  // 2. The gap since the last merge.
  if (last && queue.prs.some((p) => p.status === "pending") && t < Date.parse(last.mergedAt) + queue.gapMinutes * 60_000) {
    queue.waiting = `the ${queue.gapMinutes}-minute gap after #${last.number}`;
    delete queue.wait;
    return { queue, say };
  }

  // 3. The next PR: merge it when everything is green, skip it if someone else merged it.
  for (const next of queue.prs.filter((p) => p.status === "pending")) {
    const data = await github.pr(next.repo, next.number);
    const pr = data?.repository?.pullRequest;
    if (!pr) return stop(`couldn't find ${next.url} on GitHub`);
    const d = prDecision(pr, { updatedHead: next.updatedHead });
    if (d.do === "skip") {
      Object.assign(next, { status: "skipped", note: d.why });
      say.push(`Skipped ${next.url}: ${d.why}.`);
      continue;
    }
    if (d.do === "stop") return stop(d.why);
    if (d.do === "wait") return waiting(`pr:${next.number}:${pr.headRefOid}:${d.why}`, d.why);
    if (d.do === "ready") {
      if (next.readied) return stop(`#${next.number} is still a draft after I marked it ready`);
      await github.markReady(pr.id);
      next.readied = true;
      return waiting(`pr:${next.number}:ready`, `#${next.number} was just marked ready for review`);
    }
    if (d.do === "update") {
      await github.updateBranch(next.repo, next.number, pr.headRefOid);
      next.updatedHead = pr.headRefOid;
      return waiting(`pr:${next.number}:update`, d.why);
    }
    const method = mergeMethod(data.repository);
    if (!method) return stop(`\`${next.repo}\` allows no merge method I can use`);
    try {
      next.sha = await github.merge(next.repo, next.number, { sha: pr.headRefOid, method });
    } catch (err) {
      return stop(`GitHub refused to merge #${next.number}: ${String(err.stderr || err.message || err).trim().split("\n").pop().slice(0, 300)}`);
    }
    Object.assign(next, { status: "merged", mergedAt: now.toISOString(), base: pr.baseRefName, method });
    delete queue.wait;
    queue.waiting = `CI on \`${pr.baseRefName}\` after #${next.number}`;
    return { queue, say };
  }

  // 4. Nothing left.
  queue.state = "done";
  queue.finishedAt = now.toISOString();
  delete queue.waiting;
  return { queue, say: [...say, summary(queue, `**Done:** every PR is merged and CI is green, ${minutes(t - Date.parse(queue.startedAt))} minutes in all.`)], done: "done" };
}

/** The table of the queue's PRs. */
export function summary(queue, headline) {
  const STATUS = { merged: "✅ merged", skipped: "↷ skipped", pending: "waiting" };
  const rows = queue.prs.map((p) => `| ${p.url} | ${STATUS[p.status] ?? p.status}${p.mergedAt ? ` at ${clock(p.mergedAt)}` : ""}${p.note ? ` (${p.note})` : ""} |`);
  return [headline, "", "| PR | |", "|---|---|", ...rows].join("\n");
}

function stoppedComment(queue) {
  const next = queue.prs.find((p) => p.status === "pending");
  return summary(
    queue,
    `**Stopped the merges:** ${queue.reason}.${next ? ` Once it's sorted, tell me to carry on and I'll continue from #${next.number}.` : ""}`,
  );
}

/** The newest queue for a task, with the user's new PRs: replaces pending ones, keeps what's merged. */
export function startOrResume(existing, prs, { gapMinutes, now = new Date() }) {
  if (!prs.length) {
    if (!existing || !existing.prs.some((p) => p.status === "pending")) return undefined;
    return { ...existing, state: "running", gapMinutes: gapMinutes ?? existing.gapMinutes, reason: undefined, wait: undefined };
  }
  const done = (existing?.prs ?? []).filter((p) => p.status !== "pending");
  const fresh = prs.filter((p) => !done.some((d) => d.repo.toLowerCase() === p.repo.toLowerCase() && d.number === p.number));
  if (!fresh.length) return undefined;
  const q = newQueue(fresh, { gapMinutes: gapMinutes ?? existing?.gapMinutes ?? 15, now });
  q.prs = [...done, ...q.prs];
  return q;
}
