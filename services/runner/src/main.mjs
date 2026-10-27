#!/usr/bin/env node
// Pennyworth runner: turns your comments on Paperclip tasks labelled "engineer" into
// Codex / Claude Code / OpenRouter coding jobs in runner-owned git worktrees on this machine.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RUNNER_MARKER, isAgentSubtask, isUserPart, ownRequest, findRepos, mentionedRepos, readOnlyRefusal, isClaudeModel, normalizeRepo, openrouterModels, crewNames, personaFor, parseCommand, pickedEngine, pickerFor, repoAllowed, resolveEngine, resolveMode, resolveShells, stripHidden } from "./commands.mjs";
import { loadConfig } from "./config.mjs";
import { observes, runAgent } from "./engines.mjs";
import { gcpSession } from "./gcp.mjs";
import { syncFiles } from "./files.mjs";
import { changesSummary, defaultBranch, detectShells, ensureClone, ensureGuardHooks, git, remoteIsEmpty } from "./git.mjs";
import { codexModels, readApproval, readRequest, resolveModelAlias, withParent } from "./intake.mjs";
import { Paperclip } from "./paperclip.mjs";
import { branchGuidance, checkBranchName, chooseBranchName, exampleBranches } from "./branch.mjs";
import { cleanMessages, leaksInternal, writePrDescription } from "./describe.mjs";
import { branchesFooter, commitMessage, firstPrompt, followUpPrompt, latestReport, latestResult, prSummary, prTitle, subtaskSummary, runOutcome, stripAnswerHeading, stripCommitLine } from "./prompt.mjs";
import { PRIMER_FILE, publishDocument } from "./primer.mjs";
import { startRepoHelper } from "./repohelper.mjs";
import { baseRef, branchChanges, carryOver, dirtyCheckouts, ensureRepo, findBranches, keepBranches, messagesSince, moveOffDefault, readManifest, signUnsigned, workspacePath, workspaceRepos } from "./workspace.mjs";
import { ACTIVITY_QUERY, Board, activityComment, activitySearches, formatRepo } from "./recurring.mjs";
import { PR_QUERY, reviewOutcome, reviewTarget } from "./reviews.mjs";
import * as merges from "./merges.mjs";
import { State } from "./state.mjs";

const execFileP = promisify(execFile);
const cfg = loadConfig();
const pc = new Paperclip(cfg);
const state = new State(cfg.stateDir);
const logsDir = join(cfg.stateDir, "logs");
mkdirSync(logsDir, { recursive: true, mode: 0o700 });

const running = new Map(); // issueId → { controller, jobId, identifier, startedAt, info }
const queue = []; // { issue, instructions, read, candidates }
const log = (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const engineLabel = (e) => {
  const details = [e.model, e.effort && `${e.effort} effort`].filter(Boolean).join(", ");
  return e.kind === "codex" ? `Codex${details ? ` (${details})` : ""}` : e.kind === "claude" ? `Claude Code${details ? ` (${details})` : ""}` : `OpenRouter ${e.model}`;
};

// ------------------------------------------------------------------ polling

async function poll() {
  const since = state.get("last_poll");
  const now = new Date().toISOString();
  // Overlap the window so comments landing during a poll are never missed (handled IDs dedupe).
  const updatedSince = since ? new Date(Date.parse(since) - 120_000).toISOString() : undefined;
  // Tasks labelled "engineer" or assigned to an Engineer agent.
  const byId = new Map((await pc.labelledIssues(cfg.label, updatedSince)).map((i) => [i.id, i]));
  const engineers = await pc.engineerAgents().catch(() => []);
  for (const a of engineers) for (const i of await pc.assignedIssues(a.id, updatedSince)) byId.set(i.id, i);
  const engineerIds = new Set(engineers.map((a) => a.id));
  for (const issue of byId.values()) await handleIssue(issue, engineerIds).catch((err) => reportError(issue, err));
  // Replies: all of your open tasks (comments don't reliably bump "updated"), at most once a minute.
  if (cfg.replies?.enabled !== false && Date.now() - lastReplyCheck >= 60_000) {
    lastReplyCheck = Date.now();
    await dispatchReplies().catch((err) => log("reply dispatch failed", { err: String(err.message ?? err).slice(0, 300) }));
  }
  // Review requests you already handled on GitHub (D-21).
  if (cfg.reviews?.enabled !== false && Date.now() - lastReviewCheck >= (cfg.reviews?.interval_minutes ?? 5) * 60_000) {
    lastReviewCheck = Date.now();
    await closeReviewedTasks().catch((err) => log("review check failed", { err: String(err.stderr || err.message || err).slice(0, 300) }));
  }
  // Recurring tasks that are due (D-25), at most once a minute.
  if (board && Date.now() - lastRecurringCheck >= 60_000) {
    lastRecurringCheck = Date.now();
    await startRecurringRuns().catch((err) => log("recurring check failed", { err: String(err.message ?? err).slice(0, 300) }));
  }
  // Merges you asked for (D-46), at most once a minute.
  if (Date.now() - lastMergeCheck >= 60_000) {
    lastMergeCheck = Date.now();
    await advanceMerges().catch((err) => log("merge check failed", { err: String(err.message ?? err).slice(0, 300) }));
  }
  state.set("last_poll", now);
  drainQueue();
}

// ------------------------------------------------------------------ recurring tasks (D-25)

let lastRecurringCheck = 0;
const boardApi = (() => {
  try {
    return new Board(cfg.boardInternalUrl, cfg.boardTokenFile);
  } catch (err) {
    log("board unreachable: no board token (recurring tasks and the Agents view are off)", { err: String(err.message ?? err).slice(0, 200) });
    return undefined;
  }
})();
const board = cfg.recurring?.enabled === false ? undefined : boardApi;

// ------------------------------------------------------------------ activity for the board's Agents view

let activityError = "";
/** Tell the board what is running, queued and recently finished: every 30 seconds and on every job start and end. */
function reportActivity() {
  if (!boardApi) return;
  const merging = activeMerges()
    .map((issueId) => [issueId, mergeQueue(issueId)])
    .filter(([issueId, q]) => q?.state === "running" && !running.has(issueId))
    .map(([issueId, q]) => ({ issueId, identifier: q.identifier, startedAt: q.startedAt, engine: q.engine, mode: "merging PRs", repo: [...new Set(q.prs.map((p) => p.repo))].join(", ").slice(0, 200) }));
  const body = {
    running: [...[...running.entries()].map(([issueId, r]) => ({ issueId, identifier: r.identifier, startedAt: r.startedAt, ...(r.info ?? {}) })), ...merging].slice(0, 50),
    queued: queue.filter((j) => !running.has(j.issue.id)).map((j) => ({ issueId: j.issue.id, identifier: j.issue.identifier })),
    recent: state.recentJobs(15).map((j) => ({ issueId: j.issue_id, identifier: j.identifier, engine: j.engine ?? undefined, status: j.status, startedAt: j.started_at, finishedAt: j.finished_at })),
    latest: state.latestJobs(200).map((j) => ({ identifier: j.identifier, status: j.status })),
  };
  boardApi.post("/internal/runner/activity", body).then(
    () => (activityError = ""),
    (err) => {
      const msg = String(err.message ?? err).slice(0, 200);
      if (msg !== activityError) log("activity report failed", { err: msg });
      activityError = msg;
    },
  );
}

/**
 * The board creates the user's task for each due run (top of Today) and hands it here: add the
 * period's GitHub activity for the definition's repositories, then start the Assistant on it.
 */
async function startRecurringRuns() {
  for (const run of await board.claim()) {
    try {
      const digestKey = `recurring_digest:${run.outputId}`;
      if (run.repos.length && !state.get(digestKey)) {
        await pc.comment(run.outputId, await githubActivity(run));
        state.set(digestKey, new Date().toISOString());
      }
      await pc.runRoutine(cfg.recurring?.routine ?? "Run recurring task", {
        definition: run.definition,
        task: run.output,
        since: run.sinceLocal,
        until: run.untilLocal,
        timezone: run.timezone,
        previous: run.previous ?? "none (first run)",
      });
      await board.runState(run, "started");
      log("recurring run started", { definition: run.definition, output: run.output, occurrence: run.occurrence, repos: run.repos.length, attempt: run.attempt });
    } catch (err) {
      log("recurring run failed to start", { output: run.output, attempt: run.attempt, err: String(err.message ?? err).slice(0, 300) });
      // Left claimed: the board hands it out again in a few minutes, and says so on the task if it never starts.
    }
  }
}

/** The period's activity in each repository: fixed read-only GraphQL with your gh login. */
async function githubActivity(run) {
  const gh = await findRealGh();
  const sections = [];
  for (const repo of run.repos) {
    const [owner, name] = repo.split("/");
    const q = activitySearches(repo, run.since, run.until);
    try {
      const args = ["api", "graphql", "-f", `query=${ACTIVITY_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `since=${run.since}`, "-f", `until=${run.until}`];
      for (const [k, v] of Object.entries(q)) args.push("-f", `${k}=${v}`);
      const { stdout } = await execFileP(gh, args, { maxBuffer: 16 * 1024 * 1024 });
      sections.push(formatRepo(repo, JSON.parse(stdout).data, run.since, run.until));
    } catch (err) {
      sections.push(formatRepo(repo, undefined, run.since, run.until, String(err.stderr || err.message || err).split("\n")[0]));
    }
  }
  return activityComment(run, sections);
}

// ------------------------------------------------------------------ review requests → GitHub

let lastReviewCheck = 0;
let githubLogin;

/** Close your open review-request tasks once GitHub shows you reviewed the PR, or it was merged or closed. */
async function closeReviewedTasks() {
  const gh = await findRealGh();
  for (let issue of await pc.myOpenIssues()) {
    if ((issue.labels ?? []).some((l) => l.name === cfg.label || l.name === "recurring")) continue; // coding tasks are the runner's own; recurring ones are instructions
    if (issue.descriptionTruncated) issue = await pc.issue(issue.id);
    const target = reviewTarget(issue);
    if (!target) continue;
    // Read-only GraphQL queries with your gh login; nothing is written to GitHub.
    githubLogin ??= (await execFileP(gh, ["api", "user", "--jq", ".login"])).stdout.trim();
    let pr;
    try {
      const { stdout } = await execFileP(gh, ["api", "graphql", "-f", `query=${PR_QUERY}`, "-f", `owner=${target.owner}`, "-f", `repo=${target.repo}`, "-F", `number=${target.number}`]);
      pr = JSON.parse(stdout).data?.repository?.pullRequest;
    } catch (err) {
      log("pr review check failed", { issue: issue.identifier, pr: `${target.owner}/${target.repo}#${target.number}`, err: String(err.stderr || err.message).slice(0, 200) });
      continue;
    }
    const outcome = reviewOutcome(pr, githubLogin, target.asked);
    if (!outcome) continue;
    await pc.setStatus(issue.id, outcome.status, outcome.comment);
    log("review task closed", { issue: issue.identifier, status: outcome.status, pr: pr.url });
  }
}

async function handleIssue(issue, engineerIds) {
  const known = state.task(issue.id);
  const task = known ?? state.ensureTask(issue.id, issue.identifier);
  // Comments written before the runner first saw the task only count if they are recent
  // (so "comment, then add the label" works, but old discussions don't trigger jobs).
  const horizon = known ? 0 : Date.now() - (cfg.first_seen_lookback_minutes ?? 30) * 60_000;
  const userComments = (await pc.comments(issue.id)).filter((c) => Paperclip.isUserInstruction(c));
  const comments = userComments.filter((c) => !state.handled(c.id));
  const fresh = comments.filter((c) => known || Date.parse(c.createdAt) >= horizon);
  for (const c of comments.filter((x) => !fresh.includes(x))) state.markHandled(c.id, issue.id);
  if (!fresh.length) {
    // Newly assigned to an Engineer without comments. A task the user wrote themselves is the
    // request (its description); otherwise ask, once.
    // The description may arrive after the assignment (assign, then paste), so it is checked on
    // every update until it has been taken up, not only the first time.
    if (engineerIds.has(issue.assigneeAgentId) && !userComments.length && !running.has(issue.id) && !state.get(`ownreq:${issue.id}`) && !state.get(`history:${issue.id}`)) {
      const full = await pc.issue(issue.id);
      if (requestFrom(full)) {
        state.set(`ownreq:${issue.id}`, new Date().toISOString());
        return handleRequest(issue, ""); // the description is the request
      }
      // Sub-tasks the Assistant created wait quietly for the go-ahead on their parent (D-24).
      if (isAgentSubtask(full)) return;
      if (!state.get(`greeted:${issue.id}`)) {
        state.set(`greeted:${issue.id}`, new Date().toISOString());
        await pc.comment(issue.id, "Ready. What would you like me to do, and in which repository? (Or write it in the task description.)");
      }
    }
    return;
  }

  const texts = [];
  for (const c of fresh) {
    state.markHandled(c.id, issue.id);
    const command = parseCommand(c.body); // exactly "push" or "pr"
    if (command) {
      await runCommand(issue, state.task(issue.id), command);
      continue;
    }
    const text = stripHidden(c.body).trim();
    if (text) texts.push(text);
  }
  if (texts.length) await handleRequest(issue, texts.join("\n\n"));
}

/**
 * Read a plain-language request (one or more new comments) before anything is queued, so
 * "stop that" or "how's it going?" work while a run is in progress. The intake decides what is
 * asked; push and pr still need the exact word, so they are only suggested.
 */
/**
 * The request in a task's description: the user's own task, or a sub-task the Assistant created
 * that the user has given the go-ahead for (D-24). Empty for everything else.
 */
function requestFrom(full) {
  const own = ownRequest(full);
  if (own) return own;
  return isAgentSubtask(full) && state.get(`approved:${full.id}`) ? stripHidden(full.description).trim() : "";
}

async function handleRequest(issue, latest) {
  const full = await pc.issue(issue.id);
  let instructions = latest;
  // Commenting on a sub-task the Assistant created is the go-ahead for that one (D-24).
  if (latest && isAgentSubtask(full)) state.set(`approved:${issue.id}`, new Date().toISOString());
  // First run on a task the user wrote (or approved): its title and description are part of the request.
  if (!state.get(`history:${issue.id}`)) {
    const own = requestFrom(full);
    if (own) instructions = [`${full.title}\n\n${own}`, instructions].filter(Boolean).join("\n\n");
  }
  // A request still waiting on an answer (e.g. which repository) is combined with the answer.
  const pending = state.get(`pending:${issue.id}`);
  if (pending) instructions = `${pending}\n\n${instructions}`;

  // An Engineer's part (D-45) is often just "go ahead": the user's task it belongs to names the repositories.
  const parent = await crewParent(full).catch(() => undefined);
  const description = withParent(full.description, parent);
  const candidates = await repoCandidates(`${instructions}\n${full.title}\n${description}`);
  const before = state.task(issue.id);
  const busy = running.has(issue.id) || queue.some((j) => j.issue.id === issue.id);
  const hasWork = await taskHasCommits(before);
  const engineers = await pc.engineerAgents().catch(() => []);
  const openrouter = openrouterModels(engineers);
  const read = await readRequest({ cfg, user: cfg.selfName, title: full.title, description, instructions, latest, candidates, openrouter, crew: crewNames(engineers), known: before.repo, previousMode: before.mode, busy, hasWork, lastResult: await lastResultOf(issue.id).catch(() => undefined) })
    .catch((err) => (log("intake failed", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 300) }), undefined));
  // Publishing needs something to publish: "build X and prepare a PR" on a fresh task is a run.
  const action = (read?.action === "push" || read?.action === "pr") && !hasWork ? "run" : (read?.action ?? "run");
  log("request read", { issue: issue.identifier, action, mode: read?.mode });

  if (action === "merge") return startMerges(issue, full, instructions, latest, read?.gapMinutes);
  if (["stop", "status", "reset", "cleanup"].includes(action)) {
    if (action === "stop" && mergeQueue(issue.id)?.state === "running" && !running.has(issue.id)) return stopMerges(issue, "you asked me to stop");
    if (action === "stop") {
      const before = queue.length;
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].issue.id === issue.id) queue.splice(i, 1);
      if (!running.has(issue.id) && queue.length < before) return void (await pc.comment(issue.id, "Cancelled the queued request. Nothing else was running."));
    }
    return runCommand(issue, state.task(issue.id), action);
  }
  if (action === "push" || action === "pr") {
    const what = action === "push" ? "publish the task's branches to GitHub" : "push the task's branches and open draft PRs";
    return void (await pc.comment(issue.id, `To ${what}, reply with just **${action}**. I only publish on that exact word.`));
  }
  return dispatch({ issue, instructions, read, candidates, full });
}

/**
 * Repositories a request can work in: any in the allowed orgs, plus public repositories elsewhere,
 * which are read-only (D-35). Tokens outside the orgs are checked on GitHub, so "DA/L1" isn't one.
 */
async function repoCandidates(text) {
  const out = findRepos(text, cfg.allowed_orgs).map((r) => r.slug);
  const outside = mentionedRepos(text).filter((r) => !repoAllowed(r, cfg.allowed_orgs)).slice(0, 10);
  for (const r of outside) {
    const slug = await publicRepo(r.slug);
    if (slug && !out.some((o) => o.toLowerCase() === slug.toLowerCase())) out.push(slug);
  }
  return out;
}

const publicRepos = new Map(); // slug (lowercase) → GitHub's name for a public repo, or null
/** GitHub's name for a public repository, or undefined (private, missing, or not a repository). */
async function publicRepo(slug) {
  const key = slug.toLowerCase();
  if (!publicRepos.has(key)) {
    let name = null;
    try {
      const { stdout } = await execFileP(await findRealGh(), ["api", `repos/${slug}`, "--jq", "select(.private == false) | .full_name"], { timeout: 20_000 });
      name = stdout.trim() || null;
    } catch {}
    publicRepos.set(key, name);
  }
  return publicRepos.get(key) ?? undefined;
}

async function dispatch(job) {
  const { issue } = job;
  if (running.has(issue.id)) {
    queue.push(job);
    await pc.comment(issue.id, "Queued: I'll pick this up as soon as the current run on this task finishes.");
  } else if (running.size >= (cfg.max_concurrent ?? 2)) {
    queue.push(job);
    await pc.comment(issue.id, `Queued: ${running.size} job(s) already running.`);
  } else {
    void startJob(job);
  }
}

// ------------------------------------------------------------------ merges (D-46)

let lastMergeCheck = 0;
const mergeQueue = (issueId) => (state.get(`merges:${issueId}`) ? JSON.parse(state.get(`merges:${issueId}`)) : undefined);
const activeMerges = () => JSON.parse(state.get("merges:active") || "[]");
function saveMerges(issueId, queue) {
  state.set(`merges:${issueId}`, JSON.stringify(queue));
  const active = activeMerges().filter((id) => id !== issueId);
  state.set("merges:active", JSON.stringify(queue.state === "running" ? [...active, issueId] : active));
}

/**
 * "Merge these approved PRs, 15 minutes apart": queue the PRs the comment names (else the task's),
 * or carry on with a stopped queue. advanceMerges() does the merging, one poll at a time.
 */
async function startMerges(issue, full, instructions, latest, gapMinutes) {
  const existing = mergeQueue(issue.id);
  let prs = merges.findPrs(latest);
  if (!prs.length && !existing?.prs.some((p) => p.status === "pending")) prs = merges.findPrs(`${instructions}\n${full.description ?? ""}`);
  const outside = prs.filter((p) => !repoAllowed(normalizeRepo(p.repo), cfg.allowed_orgs));
  if (outside.length) return void (await pc.comment(issue.id, `I only merge in your orgs (${cfg.allowed_orgs.join(", ")}), so I didn't start: ${outside.map((p) => p.url).join(", ")}.`));
  if (running.has(issue.id)) return void (await pc.comment(issue.id, "Can't start merging while a run is in progress on this task. Comment **stop** first, or wait for it to finish."));
  const queue = merges.startOrResume(existing, prs, { gapMinutes: gapMinutes ?? existing?.gapMinutes ?? cfg.merges?.gap_minutes ?? 15 });
  if (!queue) return void (await pc.comment(issue.id, existing?.state === "done" ? "Every PR on this task is already merged. Link the ones you want merged next." : "Which pull requests should I merge? Link them in a comment (or in the task), in the order you want them merged."));
  const engine = state.task(issue.id)?.engine;
  Object.assign(queue, { identifier: issue.identifier, engine: engine ? engineLabel(engine) : undefined });
  saveMerges(issue.id, queue);
  const pending = queue.prs.filter((p) => p.status === "pending");
  await pc.startWork(
    issue.id,
    `${existing && !prs.length ? "Carrying on" : "On it"}: merging ${pending.length} PR${pending.length === 1 ? "" : "s"} one at a time${pending.length > 1 && queue.gapMinutes ? `, at least ${queue.gapMinutes} minutes apart` : ""}, in this order: ${pending.map((p) => `#${p.number}`).join(", ")}. Each one has to be approved with green checks, and its base branch green before and after it. If anything isn't, I stop and tell you here.`,
  );
  log("merges started", { issue: issue.identifier, prs: pending.length, gap: queue.gapMinutes });
  lastMergeCheck = 0; // start right away
  reportActivity();
}

async function stopMerges(issue, why) {
  const queue = mergeQueue(issue.id);
  Object.assign(queue, { state: "stopped", reason: why, stoppedAt: new Date().toISOString() });
  saveMerges(issue.id, queue);
  const next = queue.prs.find((p) => p.status === "pending");
  await pc.setStatus(issue.id, "in_review", merges.summary(queue, `**Stopped the merges** (${why}).${next ? ` Tell me to carry on and I'll continue from #${next.number}.` : ""}`));
  reportActivity();
}

/** One step for every running queue: GitHub reads and writes go through mergeGithub. */
async function advanceMerges() {
  for (const issueId of activeMerges()) {
    const queue = mergeQueue(issueId);
    if (queue?.state !== "running") {
      if (queue) saveMerges(issueId, queue);
      else state.set("merges:active", JSON.stringify(activeMerges().filter((id) => id !== issueId)));
      continue;
    }
    let step;
    try {
      step = await merges.advance(queue, { github: mergeGithub, timeoutMinutes: cfg.merges?.timeout_minutes ?? 90 });
      queue.errors = 0;
    } catch (err) {
      // GitHub or the network: try again next minute, and give up after ten in a row.
      queue.errors = (queue.errors ?? 0) + 1;
      log("merge step failed", { issue: queue.identifier, errors: queue.errors, err: String(err.stderr || err.message || err).slice(0, 300) });
      saveMerges(issueId, queue);
      if (queue.errors >= 10) await stopMerges({ id: issueId, identifier: queue.identifier }, `GitHub kept failing: ${String(err.stderr || err.message || err).trim().split("\n").pop().slice(0, 200)}`);
      continue;
    }
    saveMerges(issueId, step.queue);
    if (step.done) await pc.setStatus(issueId, "in_review", step.say.join("\n\n"));
    else for (const s of step.say) await pc.comment(issueId, s);
    if (step.say.length || step.done) log("merges advanced", { issue: queue.identifier, state: step.queue.state, merged: step.queue.prs.filter((p) => p.status === "merged").length });
    if (step.done) reportActivity();
  }
}

/** GitHub for the merge queue, with your gh login: fixed GraphQL reads, and the writes in merges.WRITES only. */
const mergeGithub = {
  async pr(repo, number) {
    const [owner, name] = repo.split("/");
    const { stdout } = await execFileP(await findRealGh(), ["api", "graphql", "-f", `query=${merges.PR_QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${name}`, "-F", `number=${number}`], { maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout).data;
  },
  async commit(repo, oid) {
    const [owner, name] = repo.split("/");
    const { stdout } = await execFileP(await findRealGh(), ["api", "graphql", "-f", `query=${merges.COMMIT_QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${name}`, "-f", `oid=${oid}`], { maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout).data?.repository?.object;
  },
  async merge(repo, number, { sha, method }) {
    return (await githubWrite(`repos/${repo}/pulls/${number}/merge`, { merge_method: method, sha })).sha;
  },
  async updateBranch(repo, number, head) {
    await githubWrite(`repos/${repo}/pulls/${number}/update-branch`, { expected_head_sha: head });
  },
  async markReady(id) {
    const { stdout } = await execFileP(await findRealGh(), ["api", "graphql", "-f", `query=${merges.READY_MUTATION}`, "-f", `id=${id}`]);
    const res = JSON.parse(stdout);
    if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join("; "));
  },
};

async function githubWrite(path, fields) {
  if (!merges.WRITES.some((w) => w.method === "PUT" && w.path.test(path))) throw new Error(`refused GitHub write ${path}`);
  const args = ["api", "-X", "PUT", path];
  for (const [k, v] of Object.entries(fields)) args.push("-f", `${k}=${v}`);
  const { stdout } = await execFileP(await findRealGh(), args);
  return JSON.parse(stdout || "{}");
}

// ------------------------------------------------------------------ replies → Assistant

/**
 * Your comments on your own open tasks go to the Assistant ("Process task replies"),
 * after a short quiet period so a follow-up comment or closing the task is taken into account.
 * Review tasks (ops-mcp) and engineer tasks (this runner) have their own handlers.
 */
let lastReplyCheck = 0;

async function dispatchReplies() {
  const r = cfg.replies ?? {};
  const debounceMs = (r.debounce_seconds ?? 90) * 1000;
  const exclude = new Set(r.exclude_labels ?? ["needs-review", cfg.label]);
  let since = state.get("replies_since");
  if (!since) {
    since = new Date(Date.now() - (r.first_run_lookback_hours ?? 24) * 3_600_000).toISOString();
    state.set("replies_since", since);
  }
  const ready = [];
  const pending = [];
  for (const issue of await pc.myOpenIssues()) {
    if ((issue.labels ?? []).some((l) => exclude.has(l.name))) continue;
    let fresh = (await pc.comments(issue.id)).filter((c) => Paperclip.isUserInstruction(c) && c.createdAt >= since && !state.handled(c.id));
    if (!fresh.length) continue;
    // An exact "pr" on a parent opens the PRs of all its finished Engineer sub-tasks (D-24), right away.
    if (await handleParentPr(issue, fresh)) fresh = fresh.filter((c) => !state.handled(c.id));
    if (!fresh.length) continue;
    // Wait until the newest comment on this task is older than the debounce window.
    if (Date.now() - Date.parse(fresh.at(-1).createdAt) < debounceMs) continue;
    // Sub-tasks waiting for a go-ahead on this task: the runner reads the comment first (D-24).
    if (await handleGoAhead(issue, fresh)) continue;
    ready.push(issue.identifier);
    pending.push(...fresh.map((c) => [c.id, issue.id]));
  }
  if (!ready.length) return;
  await pc.runRoutine(r.routine ?? "Process task replies", { tasks: ready.join(", ") });
  for (const [cid, iid] of pending) state.markHandled(cid, iid);
  log("replies dispatched to Assistant", { tasks: ready });
}

/**
 * If Engineer sub-tasks the Assistant created under this task are waiting, decide whether the
 * user's new comments are the go-ahead. "start" starts them all, "hold" keeps them waiting; anything
 * else (changes, questions) goes to the Assistant as usual. True when the comments were handled here.
 */
async function handleGoAhead(parent, fresh) {
  const engineers = await pc.engineerAgents();
  const waiting = (await pc.children(parent.id)).filter(
    (c) => engineers.some((a) => a.id === c.assigneeAgentId) && isAgentSubtask(c) && c.status === "todo" && !state.get(`approved:${c.id}`) && !state.get(`history:${c.id}`),
  );
  if (!waiting.length) return false;
  const comment = fresh.map((c) => stripHidden(c.body).trim()).filter(Boolean).join("\n\n");
  const decision = await readApproval({ cfg, user: cfg.selfName, title: parent.title, waiting, comment }).catch((err) => {
    log("go-ahead check failed", { issue: parent.identifier, err: String(err.message ?? err).slice(0, 300) });
    return "other";
  });
  log("go-ahead read", { issue: parent.identifier, decision, waiting: waiting.length });
  if (decision === "other") return false;
  for (const c of fresh) state.markHandled(c.id, parent.id);
  if (decision === "hold") {
    await pc.comment(parent.id, `OK, the ${waiting.length} Engineer task${waiting.length === 1 ? "" : "s"} will wait until you say go.`);
    return true;
  }
  const now = new Date().toISOString();
  for (const c of waiting) state.set(`approved:${c.id}`, now), state.set(`ownreq:${c.id}`, now);
  await pc.comment(
    parent.id,
    `Starting ${waiting.length} Engineer task${waiting.length === 1 ? "" : "s"}: ${waiting.map((c) => c.identifier).join(", ")}. They run ${cfg.max_concurrent ?? 2} at a time, and each one reports on its own task; reply **pr** there to open its PR.`,
  );
  log("sub-tasks approved", { issue: parent.identifier, tasks: waiting.map((c) => c.identifier) });
  // Read each sub-task's request in the background; dispatch() queues the runs.
  void (async () => {
    for (const c of waiting) await handleRequest(c, "").catch((err) => reportError(c, err));
  })();
  return true;
}

function drainQueue() {
  while (running.size < (cfg.max_concurrent ?? 2)) {
    const i = queue.findIndex((j) => !running.has(j.issue.id));
    if (i < 0) return;
    void startJob(queue.splice(i, 1)[0]);
  }
}

// ------------------------------------------------------------------ jobs

async function applySettings(issue, task, settings) {
  const fields = {};
  if (settings.repo) {
    const repo = normalizeRepo(settings.repo);
    if (!repo) throw new UserError(`\`${settings.repo}\` isn't a GitHub repository I can read.`);
    if (!repoAllowed(repo, cfg.allowed_orgs) && !(await publicRepo(repo.slug))) {
      throw new UserError(`\`${repo.slug}\` is outside your orgs (${cfg.allowed_orgs.join(", ")}) and isn't a public GitHub repository, so I can't work in it.`);
    }
    // A task works in several repositories (D-41): the first is its main one, the others join its workspace.
    if (!task.repo) fields.repo = repo.slug;
    else if (task.repo.toLowerCase() !== repo.slug.toLowerCase()) rememberRepos(issue.id, [repo.slug]);
  }
  if (settings.base) fields.base = settings.base.trim();
  if (settings.model && settings.engine !== "openrouter" && !isClaudeModel(settings.model)) settings.model = resolveModelAlias(settings.model, codexModels()) ?? settings.model;
  if (settings.engine || settings.model) fields.engine = resolveEngine(settings, cfg, task.engine);
  if (settings.mode) fields.mode = resolveMode(settings, task.mode);
  if (Object.keys(fields).length) state.updateTask(issue.id, fields);
  return state.task(issue.id);
}

/**
 * The executor picked on the task (D-20): its Engineer assignee and model override. A comment that
 * switches engine or names a model moves the picker, so the task always shows what runs it; so does
 * an engine remembered from before the picker existed. Otherwise the picker wins.
 */
async function syncPicker(issue, full, task, named) {
  const engineers = await pc.engineerAgents();
  const picked = pickedEngine(full, engineers, cfg);
  if (!picked) return task;
  const seenKey = `picker:${issue.id}`;
  const chosen = task.engine && ((named && (task.engine.kind !== picked.kind || task.engine.model)) || (!state.get(seenKey) && task.engine.kind !== picked.kind));
  let engine = picked;
  if (chosen) {
    const fields = pickerFor({ ...task.engine, ...(task.engine.kind === picked.kind && picked.effort ? { effort: picked.effort } : {}) }, engineers);
    if (fields) {
      await pc.setPicker(issue.id, fields);
      engine = pickedEngine({ ...full, ...fields }, engineers, cfg);
    } else engine = task.engine;
  }
  state.set(seenKey, new Date().toISOString());
  state.updateTask(issue.id, { engine });
  return state.task(issue.id);
}

/** The user's task an Engineer's part belongs to (D-45), or undefined. */
async function crewParent(full) {
  if (!full.parentId) return undefined;
  const parent = await pc.issue(full.parentId);
  return parent.assigneeUserId ? parent : undefined;
}

/**
 * An Engineer's part of the user's task (D-45): the task itself, and the latest report of every other
 * crew member on it (an agent's comment, or the runner's report on an Engineer's part).
 */
async function crewContext(full) {
  const parent = await crewParent(full);
  if (!parent) return undefined;
  const [agents, kids] = await Promise.all([pc.agents(), pc.children(parent.id, "backlog,todo,in_progress,in_review,blocked,done,cancelled")]);
  const others = [];
  for (const k of kids) {
    const persona = agents.find((a) => a.id === k.assigneeAgentId)?.metadata?.persona;
    if (k.id === full.id || typeof persona?.name !== "string") continue;
    const report = (await pc.comments(k.id)).reverse().find((c) => !Paperclip.isUserInstruction(c));
    if (report) others.push({ name: persona.name, identifier: k.identifier, report: stripHidden(report.body).trim().slice(0, 4000) });
  }
  return { parent: { identifier: parent.identifier, title: parent.title, description: stripHidden(parent.description ?? "").trim() }, others };
}

class UserError extends Error {}

async function startJob({ issue, instructions, read, candidates }) {
  const controller = new AbortController();
  let gcp;
  running.set(issue.id, { controller, identifier: issue.identifier, startedAt: new Date().toISOString() });
  reportActivity();
  let jobId;
  try {
    const full = await pc.issue(issue.id);
    const pendingKey = `pending:${issue.id}`;
    // Settings from the intake's reading of the request (handleRequest), checked in applyDirectives.
    const before = state.task(issue.id);
    const inferred = {};
    // Several repositories named and none picked: they all join the workspace, so the first leads.
    const lead = read?.repo ?? read?.references?.[0];
    if (lead && !before.repo) inferred.repo = lead;
    inferred.mode = read?.mode ?? "investigate"; // judged per request; if unreadable, change nothing
    if (read?.engine === "openrouter") Object.assign(inferred, { engine: "openrouter" }, read.model ? { model: read.model } : {});
    else if (read?.engine === "claude") Object.assign(inferred, { engine: "claude" }, read.model ? { model: read.model } : {});
    else if (read?.model) Object.assign(inferred, { engine: "codex", model: read.model });
    let task = await applySettings(issue, before, inferred);
    task = await syncPicker(issue, full, task, Boolean(inferred.engine || inferred.model));

    // Questions and investigations can run without a repository (D-48): logs, metrics and
    // infrastructure, with pennyworth-repo for any code they turn out to need. Changes need one.
    const repoless = !task.repo && !candidates.length && (task.mode ?? "investigate") !== "implement";
    if (!task.repo && !repoless) {
      if (candidates.length === 1) state.updateTask(issue.id, { repo: candidates[0] });
      else {
        state.set(pendingKey, instructions);
        throw new UserError(
          read?.question ??
            (candidates.length
              ? `Which repository should I work in: ${candidates.map((c) => `\`${c}\``).join(" or ")}? Just reply with the name.`
              : "Which repository should I work in? Reply with its GitHub link or org/name."),
        );
      }
      task = state.task(issue.id);
    }
    state.set(pendingKey, "");
    // Once asked for, the task's document goes to Primer after every run that changes it (D-44).
    if (read?.primer && !primerRecord(issue.id)) savePrimer(issue.id, {});
    // Every repository the request names joins the workspace (D-41), remembered for follow-ups.
    rememberRepos(issue.id, (read?.references ?? []).filter((r) => r.toLowerCase() !== String(task.repo).toLowerCase()));
    const engine = task.engine ?? resolveEngine({}, cfg);
    const mode = task.mode ?? "investigate";
    const readOnly = mode === "implement" && readOnlyRefusal(task.repo, cfg.allowed_orgs, "change code there");
    if (readOnly) throw new UserError(readOnly);

    const workspace = await prepareWorkspace(issue, state.task(issue.id));
    // PRs merged or closed since the last run: never keep working on them.
    const prNotes = await leaveFinishedPrs(issue, workspace);
    if (prNotes.length) instructions = `(Runner note: ${prNotes.join(" ")} Build on what is there now.)\n\n${instructions}`;
    const repos = await repoInfo(workspace, { naming: mode === "implement" ? issue : undefined });
    // Devshells: the ones chosen for this task earlier, else detected in every repository.
    const detected = [...new Set(repos.flatMap((r) => detectShells(r.path, cfg.devshells.detect)))];
    const shells = task.shells ?? resolveShells({}, detected, instructions, cfg);
    state.updateTask(issue.id, { shells, engine, mode });
    // Grafana and Google Cloud reads for Claude Code and Codex (D-48): gcloud's devshell, and a
    // read-only token of the job's own.
    const runShells = observes(engine.kind) && cfg.gcp.shell && !shells.includes(cfg.gcp.shell) ? [...shells, cfg.gcp.shell] : shells;
    gcp = observes(engine.kind)
      ? await gcpSession({ credentialsFile: cfg.gcp.credentialsFile, dir: join(cfg.stateDir, "gcloud", issue.identifier), project: cfg.gcp.projects[0], log: (m, f) => log(m, { issue: issue.identifier, ...f }) })
      : undefined;
    if (gcp && gcp.state !== "ok" && gcp.state !== "missing") log("gcp unavailable for the job", { issue: issue.identifier, state: gcp.state, detail: gcp.detail });

    const logPath = join(logsDir, `${issue.identifier}-${Date.now()}.log`);
    jobId = state.startJob(issue.id, engineLabel(engine), logPath);
    Object.assign(running.get(issue.id), { jobId, info: { engine: engineLabel(engine), mode, repo: task.repo } });
    reportActivity();
    // A saved session can only be continued by the engine that created it (Codex, Claude Code and
    // opencode sessions are not interchangeable). After a switch the new engine starts fresh, with the
    // earlier requests on this task and the work already on its branches as context.
    const sessionEngine = state.get(`session_engine:${issue.id}`) || (String(task.session_id).startsWith("ses_") ? "openrouter" : "codex");
    const resumed = Boolean(state.task(issue.id).session_id && sessionEngine === engine.kind);
    const historyKey = `history:${issue.id}`;
    const earlier = resumed ? "" : state.get(historyKey) || "";
    state.set(historyKey, `${state.get(historyKey) || ""}\n\n---\n\n${instructions}`.trim().slice(-20_000));
    const where = repos.length ? repos.map((r) => `\`${r.slug}\``).join(", ") : "no repository";
    await pc.startWork(
      issue.id,
      mode === "answer"
        ? `Looking into your question${repos.length ? ` in ${where}` : ""} with ${engineLabel(engine)}. I'll answer here.`
        : `${prNotes.length && mode === "implement" ? `${prNotes.join(" ")}\n\n` : ""}${resumed ? "Continuing" : "On it"}: ${mode === "implement" ? "making the changes" : "investigating"}${repos.length ? ` in ${where}` : ""}, with ${engineLabel(engine)}. I'll post the result here.\n\n_Workspace \`${workspace}\` · shells ${runShells.join(", ")}${gcp && gcp.state !== "ok" ? ` · Google Cloud: ${gcp.detail}` : ""}_`,
    );
    log("job started", { issue: issue.identifier, repos: repos.map((r) => r.slug), engine: engine.kind, mode, resumed });

    const branches = state.branches(issue.id);
    const files = await syncFiles(pc, full, workspace, log);
    const primer = primerRecord(issue.id);
    // The task this is part of and what the others on it found (D-45): on the first run, then again when it changed.
    const crewCtx = await crewContext(full).catch((err) => (log("crew context unavailable", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 200) }), undefined));
    const crewKey = `crew:${issue.id}`;
    const crewHash = crewCtx ? createHash("sha256").update(JSON.stringify(crewCtx)).digest("hex") : "";
    const crew = crewCtx && (!resumed || state.get(crewKey) !== crewHash) ? crewCtx : undefined;
    if (crewHash) state.set(crewKey, crewHash);
    const observe = observes(engine.kind) ? { grafana: existsSync(cfg.grafanaTokenFile), gcp: { state: gcp.state, detail: gcp.detail, projects: cfg.gcp.projects } } : undefined;
    const prompt = resumed
      ? followUpPrompt({ user: cfg.selfName, mode, instructions, workspace, repos, branches, files, primer, crew, observe })
      : firstPrompt({ user: cfg.selfName, task: full, workspace, repos, branches, mode, shells: runShells, instructions, earlier, files, primer, persona: personaFor(engine.kind, await pc.engineerAgents().catch(() => [])), crew, observe });
    const tipsBefore = await branchTips(workspace);
    const helper = repoHelper.register({ issue, workspace });
    let result;
    try {
      result = await runAgent({ cfg, engine, shells: runShells, worktree: workspace, prompt, sessionId: resumed ? state.task(issue.id).session_id : undefined, logPath, signal: controller.signal, env: helper.env, gcp });
    } finally {
      helper.done();
    }
    if (result.sessionId) {
      state.updateTask(issue.id, { session_id: result.sessionId });
      state.set(`session_engine:${issue.id}`, engine.kind);
    }

    if (result.cancelled) {
      state.finishJob(jobId, "cancelled");
      await pc.setStatus(issue.id, "in_review", "Stopped on request. Whatever the run had changed is still in the workspace.");
      return;
    }

    const after = await workspaceRepos(workspace);
    const dirty = await dirtyCheckouts(after);
    // Agents commit as they go: the run changed something if any branch moved or appeared.
    const committedNow = (await branchTips(workspace)) !== tipsBefore;
    const outcome = runOutcome({ ...result, timeoutMinutes: cfg.timeout_minutes ?? 60, mode, dirty: dirty.length > 0, committed: committedNow });
    const whereNow = after.length ? after.map((r) => `\`${r.slug}\``).join(", ") : "no repository";
    // Commit what's left uncommitted (implement, finished runs only), put every commit on a properly
    // named branch, and sign the agent's commits.
    const tidy = await tidyBranches(issue, workspace, { commitDirty: mode === "implement" && outcome.finished, message: publicSubject(commitMessage(result.lastMessage, `chore: ${full.title}`)) });
    const rows = await branchRows(issue, workspace);

    const report = stripCommitLine(result.lastMessage);
    const stillDirty = (await dirtyCheckouts(after)).length > 0;
    const primerNote = outcome.finished ? await publishToPrimer(issue, full, workspace) : "";
    if (mode === "answer" && outcome.finished) {
      await pc.setStatus(issue.id, "in_review", `${stripAnswerHeading(report)}${primerNote ? `\n\n${primerNote}` : ""}\n\n_${engineLabel(engine)} · ${whereNow}${stillDirty ? " · note: the workspace has uncommitted changes" : ""}_`);
      state.finishJob(jobId, "done");
      log("job finished", { issue: issue.identifier, code: result.code, mode });
      return;
    }
    const parts = [
      outcome.headline,
      outcome.finished ? "" : `\nLast lines of the log:\n\`\`\`\n${logTail(logPath)}\n\`\`\`${report ? `\n\nThe agent's last message:\n\n> ${report.slice(0, 1500).replace(/\n/g, "\n> ")}` : ""}`,
      outcome.finished ? `\n${report}` : "",
      primerNote ? `\n${primerNote}` : "",
      "",
      "---",
      `${engineLabel(engine)} · ${mode} · ${whereNow}`,
      branchesFooter(rows, { multiRepo: new Set(rows.map((r) => r.repo)).size > 1 }),
      ...tidy.notes.map((n) => `\n_${n}_`),
    ];
    if (stillDirty) parts.push("\n_Note: the workspace has uncommitted changes._");
    parts.push(`Workspace: \`${workspace}\` · log: \`${logPath}\``);
    // Failures also go to review (Paperclip refuses "blocked" without a blocker); the report says what failed.
    await pc.setStatus(issue.id, "in_review", parts.filter(Boolean).join("\n"));
    state.finishJob(jobId, result.timedOut ? "timeout" : result.code ? "failed" : outcome.finished ? "done" : "incomplete", rows.some((r) => r.unpublished.length) ? "committed" : undefined);
    log("job finished", { issue: issue.identifier, code: result.code, timedOut: result.timedOut, branches: rows.length, committed: tidy.committed });
  } catch (err) {
    if (jobId) state.finishJob(jobId, "failed", String(err).slice(0, 500));
    await reportError(issue, err);
  } finally {
    gcp?.done();
    running.delete(issue.id);
    drainQueue();
    reportActivity();
    void reportToParent(issue).catch((err) => log("parent summary failed", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 300) }));
  }
}

// ------------------------------------------------------------------ Primer (D-44)

const primerRecord = (issueId) => (state.get(`primer:${issueId}`) ? JSON.parse(state.get(`primer:${issueId}`)) : undefined);
const savePrimer = (issueId, record) => state.set(`primer:${issueId}`, JSON.stringify(record));

/**
 * After a finished run on a task that asked for Primer: publish the agent's document if it changed.
 * Resolves with a line for the task comment ("" when there was nothing to do).
 */
async function publishToPrimer(issue, full, workspace) {
  const record = primerRecord(issue.id);
  if (!record) return "";
  const token = existsSync(cfg.primerTokenFile) ? readFileSync(cfg.primerTokenFile, "utf8").trim() : "";
  try {
    if (!token) throw new Error("primer-mcp isn't set up (no primer_mcp_token)");
    const res = await publishDocument({ endpoint: { url: cfg.primerPublishUrl, token }, workspace, record, fallbackTitle: full.title });
    if (res.outcome === "missing") return `_No Primer document: the run didn't write \`${PRIMER_FILE}\`._`;
    if (res.outcome === "unchanged") return record.url ? `**Primer:** ${record.url} (unchanged)` : "";
    savePrimer(issue.id, res.record);
    log("published to Primer", { issue: issue.identifier, outcome: res.outcome, document: res.record.documentId });
    const link = res.record.url ?? "the new document (its link wasn't in Primer's answer)";
    return res.outcome === "created" ? `**Published to Primer:** ${link}` : `**New version on Primer:** ${link}`;
  } catch (err) {
    log("Primer publish failed", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 300) });
    return `_Couldn't publish to Primer: ${String(err.message ?? err).slice(0, 200)}. The document is in \`${join(workspace, PRIMER_FILE)}\`; the next run tries again._`;
  }
}

/**
 * "pr" on a parent: open (or update) the PR of every approved Engineer sub-task that has commits,
 * one after another in the background, then post the links on the parent. Each task's own "pr" path
 * does the work, so its guards (merged PRs, empty repos, nothing new) all apply. True when a "pr"
 * comment was taken here.
 */
async function handleParentPr(parent, fresh) {
  const asks = fresh.filter((c) => parseCommand(c.body) === "pr");
  if (!asks.length) return false;
  const engineers = await pc.engineerAgents();
  // Approved sub-tasks the Assistant made (D-24), and the parts the user gave Engineers themselves (D-45).
  const kids = (await pc.children(parent.id)).filter((c) => (isAgentSubtask(c) && state.get(`approved:${c.id}`)) || isUserPart(c, engineers));
  if (!kids.length) return false;
  for (const c of asks) state.markHandled(c.id, parent.id);
  kids.sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }));
  await pc.comment(parent.id, `Opening PRs for the Engineer tasks with commits (${kids.length} task${kids.length === 1 ? "" : "s"} to check). I'll post the links here when done.`);
  log("parent pr requested", { issue: parent.identifier, tasks: kids.length });
  void (async () => {
    const rows = [];
    for (const kid of kids) {
      const task = state.task(kid.id);
      let note = "";
      try {
        if (running.has(kid.id) || queue.some((j) => j.issue.id === kid.id)) note = "Still running: reply **pr** on it when it's done";
        else if (!(await taskHasCommits(task))) note = "Nothing to publish";
        else await runCommand(kid, task, "pr");
      } catch (err) {
        await reportError(kid, err);
        note = `Failed: ${String(err.message ?? err).split("\n")[0].slice(0, 160)}`;
      }
      rows.push({ identifier: kid.identifier, title: kid.title, prUrl: note ? "" : state.branches(kid.id).filter((b) => b.pr_url && !b.merged).map((b) => b.pr_url).join(", "), note });
    }
    await pc.comment(parent.id, prSummary(rows));
    log("parent pr done", { issue: parent.identifier, opened: rows.filter((r) => r.prUrl).length });
  })().catch((err) => log("parent pr failed", { issue: parent.identifier, err: String(err.message ?? err).slice(0, 300) }));
  return true;
}

/**
 * When the last of a parent's approved Engineer sub-tasks finishes, post one summary on the parent
 * (D-24): otherwise the parent stays silent after "Starting N tasks" while the results are spread over
 * N tasks. Once per batch: keyed on the newest job among the siblings.
 */
async function reportToParent(issue) {
  const full = await pc.issue(issue.id);
  if (!isAgentSubtask(full) || !state.get(`approved:${issue.id}`)) return;
  const siblings = (await pc.children(full.parentId, "backlog,todo,in_progress,in_review,blocked,done,cancelled")).filter((c) => isAgentSubtask(c) && state.get(`approved:${c.id}`));
  const busy = (c) => running.has(c.id) || queue.some((j) => j.issue.id === c.id) || (!state.lastJob(c.id) && ["todo", "in_progress"].includes(c.status));
  if (!siblings.length || siblings.some(busy)) return;
  const newest = Math.max(...siblings.map((c) => state.lastJob(c.id)?.id ?? 0));
  const key = `parent-summary:${full.parentId}`;
  if (Number(state.get(key) ?? 0) >= newest) return;
  state.set(key, String(newest));
  const rows = siblings
    .map((c) => ({ c, job: state.lastJob(c.id) }))
    .sort((a, b) => a.c.identifier.localeCompare(b.c.identifier, undefined, { numeric: true }))
    .map(({ c, job }) => ({ identifier: c.identifier, title: c.title, status: c.status, job: job?.status, committed: job?.detail === "committed" }));
  await pc.comment(full.parentId, subtaskSummary(rows));
  log("parent summary posted", { issue: issue.identifier, parent: full.parentId, tasks: rows.length });
}

// ------------------------------------------------------------------ commands

async function runCommand(issue, task, command) {
  if (command === "stop") {
    const r = running.get(issue.id);
    if (!r) return void (await pc.comment(issue.id, "Nothing is running on this task."));
    r.controller.abort();
    return;
  }
  if (command === "status") {
    const job = state.lastJob(issue.id);
    const since = (t) => `${Math.max(1, Math.round((Date.now() - Date.parse(t)) / 60_000))} min ago`;
    const MODE = { answer: "answering a question", investigate: "investigating", implement: "making changes" };
    const ENDED = { done: "finished", failed: "failed", timeout: "timed out", cancelled: "was stopped", interrupted: "was interrupted by a runner restart", incomplete: "stopped before finishing" };
    const queued = queue.filter((j) => j.issue.id === issue.id).length;
    const lines = [
      running.has(issue.id)
        ? `**Working on it:** ${MODE[task?.mode] ?? "running"} with ${job?.engine ?? "the agent"}, started ${job ? since(job.started_at) : "just now"}.`
        : job
          ? `**Nothing running.** The last run ${ENDED[job.status] ?? job.status} ${since(job.finished_at ?? job.started_at)}; its result is in the comments above.`
          : "**Nothing running**, and nothing has run on this task yet.",
      queued ? `${queued} more request${queued === 1 ? " is" : "s are"} queued after it.` : "",
    ];
    const mq = mergeQueue(issue.id);
    if (mq?.state === "running") lines[0] = `**Merging:** ${mq.prs.filter((p) => p.status === "merged").length} of ${mq.prs.length} merged; now waiting for ${mq.waiting ?? "the next check"}.`;
    if (mq) lines.push(`\n${merges.summary(mq, mq.state === "running" ? "" : mq.state === "stopped" ? `The merges stopped: ${mq.reason}.` : "The merges are done.").trim()}`);
    if (task?.workspace && existsSync(task.workspace) && !running.has(issue.id)) {
      const rows = await branchRows(issue, task.workspace);
      lines.push(rows.length ? branchesFooter(rows, { multiRepo: new Set(rows.map((r) => r.repo)).size > 1 }) : "\nNo branches yet.");
    }
    return void (await pc.comment(issue.id, lines.filter(Boolean).join("\n")));
  }
  if (command === "reset") {
    state.updateTask(issue.id, { session_id: null });
    return void (await pc.comment(issue.id, "Session cleared: the next run starts a fresh agent conversation (the workspace and its branches are kept)."));
  }
  if ((!task?.repo && command !== "cleanup") || (!task?.workspace && !task?.worktree)) {
    return void (await pc.comment(issue.id, `There's nothing to ${command === "pr" ? "open a PR for" : command} yet: no work has been done on this task. Tell me what to build and I'll start; ${command === "pr" ? "**pr**" : "**push**"} works once there are commits.`));
  }
  if (running.has(issue.id)) return void (await pc.comment(issue.id, `Can't ${command} while a run is in progress. Comment **stop** first, or wait for it to finish.`));
  const workspace = await prepareWorkspace(issue, task, { clone: false });

  if (command === "cleanup") {
    const repos = await workspaceRepos(workspace);
    const dirty = await dirtyCheckouts(repos);
    if (dirty.length) {
      return void (await pc.comment(issue.id, `I didn't remove the workspace: it has uncommitted changes (${dirty.map((d) => `\`${d.path}\``).join(", ")}). Ask me to commit or discard them first.`));
    }
    // Local branches stay in the runner's cache clones (refs/kept/<task>/…), in case they're needed again.
    for (const r of repos) await keepBranches(r.path, join(cfg.workDir, "repos", r.org, r.name), issue.identifier);
    rmSync(workspace, { recursive: true, force: true });
    const kept = state.branches(issue.id).length;
    for (const b of state.branches(issue.id)) state.deleteBranch(issue.id, b.repo, b.branch);
    state.updateTask(issue.id, { workspace: null, session_id: null });
    return void (await pc.comment(issue.id, `Removed the workspace.${kept ? " Its branches are kept in the runner's copies of the repositories, and pushed ones are on GitHub." : ""}`));
  }
  // Publishing takes minutes for many branches (a push and a PR description each): it shows on the
  // board as the Engineer's work in progress, holds back new runs, and "stop" ends it between branches.
  const controller = new AbortController();
  const repos = (await workspaceRepos(workspace)).map((r) => r.slug).join(", ").slice(0, 200);
  running.set(issue.id, { controller, identifier: issue.identifier, startedAt: new Date().toISOString(), info: { mode: command === "pr" ? "opening PRs" : "pushing branches", repo: repos, ...(task.engine ? { engine: engineLabel(task.engine) } : {}) } });
  reportActivity();
  try {
    await publish(issue, workspace, command, controller.signal);
  } finally {
    running.delete(issue.id);
    reportActivity();
    drainQueue();
  }
}

async function publish(issue, workspace, command, signal) {
  const notes = await leaveFinishedPrs(issue, workspace);
  const tidy = await tidyBranches(issue, workspace, { commitDirty: false });
  const rows = await branchRows(issue, workspace);
  const publishable = rows.filter((r) => !r.merged && (r.unpublished.length || (command === "pr" && !r.prUrl)));
  if (!publishable.length) {
    const open = rows.filter((r) => r.prUrl && !r.merged);
    return void (await pc.comment(issue.id, [...notes, rows.length ? (open.length ? `Nothing new to publish: GitHub already has every commit${command === "pr" ? `, and the PRs are open: ${open.map((r) => r.prUrl).join(", ")}` : ""}.` : "Nothing new to publish.") : "There are no commits to publish."].join("\n\n")));
  }
  // Parents before the branches stacked on them: a stacked PR needs its base on GitHub first.
  const ordered = [];
  const visit = (r) => {
    if (ordered.includes(r)) return;
    const parent = publishable.find((p) => p.repo === r.repo && p.branch === r.base);
    if (parent) visit(parent);
    ordered.push(r);
  };
  publishable.forEach(visit);

  const full = await pc.issue(issue.id);
  const results = [];
  for (const r of ordered) {
    const label = `${new Set(rows.map((x) => x.repo)).size > 1 ? `${r.repo} · ` : ""}\`${r.branch}\``;
    if (signal.aborted) {
      results.push(`| ${label} | not published: stopped on request |`);
      continue;
    }
    try {
      results.push(`| ${label} | ${await publishBranch(issue, full, r, command, rows)} |`);
    } catch (err) {
      log("publish failed", { issue: issue.identifier, repo: r.repo, branch: r.branch, err: String(err.stderr || err.message).slice(0, 300) });
      results.push(`| ${label} | ⚠️ ${String(err instanceof UserError ? err.message : err.stderr || err.message).trim().split("\n").slice(-3).join(" ").replace(/\|/g, "/").slice(0, 400)} |`);
    }
  }
  await pc.comment(issue.id, [...notes, ...tidy.notes.map((n) => `_${n}_`), "| Branch | Result |", "|---|---|", ...results].join("\n"));
}

/**
 * Publish one branch on the user's "push" or "pr": checks first (writable repository, a valid public
 * name, no internal names in its commits), then push (never forced), then for "pr" a draft PR into its
 * base, the parent branch for a stacked one. Returns the result line for the table.
 */
async function publishBranch(issue, full, r, command, rows) {
  if (!r.writable) throw new UserError(`not published: \`${r.repo}\` is outside your orgs (${cfg.allowed_orgs.join(", ")}), so it's read-only`);
  const empty = await remoteIsEmpty(r.path);
  if (r.branch === r.defaultBase ? !empty : !checkBranchName(r.branch, { base: r.defaultBase, defaultBranch: r.defaultBase })) throw new UserError(`not a branch name I'd publish`);
  // Only the commits being published: what's already on GitHub (other people's work) isn't ours to judge.
  const unpublishedMessages = (await git(r.path, "log", "--format=%B%x1e", r.branch, "--not", "--remotes=origin").catch(() => "")).split("\x1e");
  const leaky = unpublishedMessages.find((m) => leaksInternal(m));
  if (r.unpublished.length && leaky) throw new UserError(`a commit message mentions internal names ("${leaky.split("\n")[0].slice(0, 80)}"). Ask me to reword it`);
  const url = await git(r.path, "remote", "get-url", "origin");
  let pushed = "";
  if (r.unpublished.length || !r.onGitHub) {
    // Into an empty repository the first branch becomes its default branch, as GitHub expects.
    const target = empty ? r.defaultBase : r.branch;
    await git(r.path, "push", "--no-verify", url, `refs/heads/${r.branch}:refs/heads/${target}`);
    await git(r.path, "fetch", "--quiet", "origin");
    state.updateBranch(issue.id, r.repo, r.branch, { pushed: 1 });
    log("branch pushed", { issue: issue.identifier, repo: r.repo, branch: r.branch, target });
    if (target !== r.branch) return `The repository was empty: pushed as its first commits on \`${target}\` → https://github.com/${r.repo}/tree/${encodeURIComponent(target)}`;
    pushed = `Pushed ${r.unpublished.length} commit${r.unpublished.length === 1 ? "" : "s"}`;
  }
  if (r.prUrl) return `${pushed || "Up to date"}. PR: ${r.prUrl}`;
  if (command === "push") return `${pushed} → https://github.com/${r.repo}/compare/${r.base}...${encodeURIComponent(r.branch)}?expand=1`;
  // Written for the repository's reviewers: nothing about Pennyworth, tasks or this machine.
  const from = r.baseRef;
  if (!from) throw new UserError(`its base \`${r.base}\` isn't on GitHub, so there's nothing to open a PR into`);
  const messages = cleanMessages((await messagesSince(r.path, from, r.branch)).join("\x1e"));
  const stat = await git(r.path, "diff", "--stat", `${from}...${r.branch}`).catch(() => "");
  const diff = await git(r.path, "diff", `${from}...${r.branch}`).catch(() => "");
  const oneline = await git(r.path, "log", "--oneline", `${from}..${r.branch}`).catch(() => "");
  const subject = messages.at(-1)?.split("\n")[0] ?? full.title;
  const fallbackTitle = prTitle(oneline, rows.filter((x) => !x.merged).length > 1 || leaksInternal(full.title) ? subject : full.title);
  const siblings = rows.filter((x) => x !== r && !x.merged);
  const pr = await writePrDescription({
    cfg, repo: r.repo, base: r.base,
    request: [
      await prRequest(full),
      siblings.length ? `This pull request is one of ${siblings.length + 1} from this request; it covers only the branch \`${r.branch}\`${r.purpose ? ` (${r.purpose})` : ""}. Describe only its own changes.` : "",
      r.base !== r.defaultBase ? `It is stacked on \`${r.base}\`, which has its own pull request.` : "",
    ].filter(Boolean).join("\n\n"),
    messages, stat, diff, report: siblings.length ? undefined : await lastReport(issue.id).catch(() => undefined), fallbackTitle,
  });
  const body = leaksInternal(pr.body) ? "" : pr.body;
  log("pr description", { issue: issue.identifier, branch: r.branch, generated: pr.generated, rejected: Boolean(pr.rejected) });
  const { stdout } = await execFileP(await findRealGh(), ["pr", "create", "--draft", "--repo", r.repo, "--head", r.branch, "--base", r.base, "--title", pr.title, "--body", body], { cwd: r.path }).catch((err) => {
    // gh's error message repeats the whole command line (PR body included): show stderr only.
    throw new UserError(`couldn't open the PR. GitHub said: ${String(err.stderr || "gh pr create failed").trim().slice(-400)}`);
  });
  const prUrl = stdout.trim().split("\n").pop();
  state.updateBranch(issue.id, r.repo, r.branch, { pr_url: prUrl });
  log("draft PR opened", { issue: issue.identifier, url: prUrl });
  return `${pushed ? `${pushed}, opened` : "Opened"} draft PR ${prUrl}`;
}

/**
 * What the PR writer gets as the request: the task, and for an Engineer sub-task also the parent the
 * user wrote, which is where PR wording rules live (PEN-357's "Title: … Body: …").
 */
async function prRequest(full) {
  const own = [full.title, requestFrom(full) || stripHidden(full.description ?? "").trim()].filter(Boolean).join("\n\n");
  if (!isAgentSubtask(full)) return own;
  const parent = await pc.issue(full.parentId).catch(() => undefined);
  const parentText = parent ? ownRequest(parent) : "";
  return parentText ? `${own}\n\nThis change is one repository of a larger request (its rules for PR titles and bodies apply):\n\n${parent.title}\n\n${parentText}` : own;
}

// ------------------------------------------------------------------ workspaces (D-41)

const BRANCH_DOCS = ["CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md", ".github/pull_request_template.md"];
const ghJson = async (args) => execFileP(await findRealGh(), args).then(({ stdout }) => JSON.parse(stdout), () => undefined);
let ghLogin;
const login = async () => (ghLogin ??= (await ghJson(["api", "user"]))?.login ?? "");
const recentPrs = new Map(); // repo → { at, prs }
async function repoPrs(slug) {
  const hit = recentPrs.get(slug);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.prs;
  const prs = (await ghJson(["pr", "list", "--repo", slug, "--state", "all", "--limit", "60", "--json", "headRefName,author"])) ?? [];
  recentPrs.set(slug, { at: Date.now(), prs });
  return prs;
}
const branchDocs = (path) => branchGuidance(BRANCH_DOCS.map((f) => [f, existsSync(join(path, f)) ? readFileSync(join(path, f), "utf8") : ""]));
const writable = (slug) => repoAllowed(normalizeRepo(slug), cfg.allowed_orgs);

/** Repositories this task works in besides its main one (D-41), remembered across runs. */
function rememberRepos(issueId, slugs) {
  const key = `repos:${issueId}`;
  const list = JSON.parse(state.get(key) || state.get(`refs:${issueId}`) || "[]");
  for (const s of slugs) if (!list.some((l) => l.toLowerCase() === s.toLowerCase())) list.push(s);
  state.set(key, JSON.stringify(list));
  return list;
}

/** Clone one repository into a workspace (from the runner's cache clone). */
async function addRepo(workspace, slug) {
  const repo = normalizeRepo(slug);
  const cache = await ensureClone(cfg.workDir, repo);
  return ensureRepo(workspace, repo, { cache, hooksDir: ensureGuardHooks(cfg.workDir) });
}

/**
 * The task's workspace, with its main repository and every other one it uses cloned (unless
 * `clone: false`). A task from before workspaces (one worktree of the cache clone, one branch) moves
 * in first: its branch, PR and uncommitted changes come along, and the old worktree goes.
 */
async function prepareWorkspace(issue, task, { clone = true } = {}) {
  const workspace = task.workspace ?? workspacePath(cfg.workDir, issue.identifier);
  if (!task.workspace) state.updateTask(issue.id, { workspace });
  if (task.worktree) await moveIntoWorkspace(issue, task, workspace);
  if (clone) {
    mkdirSync(workspace, { recursive: true });
    for (const slug of [task.repo, ...rememberRepos(issue.id, [])].filter(Boolean)) {
      await addRepo(workspace, slug).catch((err) => {
        if (slug === task.repo) throw err;
        log("repository clone failed", { issue: issue.identifier, repo: slug, err: String(err.message ?? err).slice(0, 300) });
      });
    }
  }
  return workspace;
}

async function moveIntoWorkspace(issue, task, workspace) {
  const repo = normalizeRepo(task.repo);
  const cache = join(cfg.workDir, "repos", repo.org, repo.name);
  const path = await addRepo(workspace, task.repo);
  if (existsSync(task.worktree) && task.branch) {
    // Uncommitted changes travel as a binary patch, untracked files included.
    let patch = "";
    if (await git(task.worktree, "status", "--porcelain")) {
      await git(task.worktree, "add", "-A");
      patch = (await execFileP("git", ["diff", "--cached", "--binary", "HEAD"], { cwd: task.worktree, maxBuffer: 64 * 1024 * 1024 })).stdout;
    }
    await git(path, "fetch", "--quiet", cache, `+refs/heads/${task.branch}:refs/heads/${task.branch}`);
    await git(path, "switch", "--quiet", task.branch);
    if (patch) {
      const dir = mkdtempSync(join(tmpdir(), "pw-move-"));
      try {
        writeFileSync(join(dir, "p"), patch);
        await git(path, "apply", "--index", join(dir, "p"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    await git(cache, "worktree", "remove", "--force", task.worktree);
  }
  if (task.branch) {
    state.saveBranch(issue.id, { repo: repo.slug, branch: task.branch, base: task.base ?? (await defaultBranch(path)) });
    state.updateBranch(issue.id, repo.slug, task.branch, { pushed: task.pushed ? 1 : 0, pr_url: task.pr_url ?? null });
  }
  // The old session ran in the old worktree: start afresh, with the task's history as context.
  state.updateTask(issue.id, { worktree: null, branch: null, pr_url: null, pushed: 0, session_id: null });
  log("moved into a workspace", { issue: issue.identifier, branch: task.branch, workspace });
}

/** `pennyworth-repo <org/name>` from a running job: clone another repository into its workspace. */
const repoHelper = startRepoHelper(async ({ issue, workspace }, raw) => {
  const repo = normalizeRepo(raw);
  if (!repo) throw new Error(`\`${raw}\` isn't a GitHub repository (use org/name).`);
  if (!repoAllowed(repo, cfg.allowed_orgs) && !(await publicRepo(repo.slug))) throw new Error(`${repo.slug} is outside ${cfg.allowed_orgs.join(", ")} and isn't a public repository I can read.`);
  const path = await addRepo(workspace, repo.slug);
  rememberRepos(issue.id, [repo.slug]);
  log("repository added by the agent", { issue: issue.identifier, repo: repo.slug });
  return `${repo.slug} is at ${path} (default branch ${await defaultBranch(path)})${writable(repo.slug) ? "" : ". It is read-only: changes there can't be published"}.`;
}, log);

/** Each repository in the workspace for the prompt; with `naming`, its branch naming rules and examples. */
async function repoInfo(workspace, { naming } = {}) {
  const out = [];
  for (const r of await workspaceRepos(workspace)) {
    const info = { slug: r.slug, path: r.path, base: await defaultBranch(r.path), writable: writable(r.slug) };
    if (naming && info.writable) {
      const examples = exampleBranches(await repoPrs(r.slug), { login: await login(), base: info.base });
      const guidance = branchDocs(r.path);
      info.naming = [
        guidance ? `From the repository's guides:\n\n${guidance}` : "",
        examples.mine.length ? `${cfg.selfName}'s recent branches here: ${examples.mine.slice(0, 10).map((b) => `\`${b}\``).join(", ")}` : "",
        examples.others.length ? `Others' recent branches: ${examples.others.slice(0, 12).map((b) => `\`${b}\``).join(", ")}` : "",
        !guidance && !examples.mine.length && !examples.others.length ? "No convention found: use `<type>/<short-description>` with a conventional commit type." : "",
      ].filter(Boolean).join("\n\n");
    }
    out.push(info);
  }
  return out;
}

/** A branch name in the repository's style (D-32) for commits that aren't on a proper branch yet. */
async function nameBranch(issue, { path, slug, base, messages = [] }) {
  const full = await pc.issue(issue.id);
  const taken = async (name) => Boolean(await git(path, "branch", "--list", name)) || Boolean(await git(path, "ls-remote", "--heads", "origin", name).catch(() => ""));
  const { name, generated } = await chooseBranchName({
    cfg, repo: slug, base, defaultBranch: base, login: await login(), guidance: branchDocs(path), prs: await repoPrs(slug),
    request: await prRequest(full), messages: cleanMessages(messages.join("\x1e")), title: leaksInternal(full.title) ? "" : full.title, taken,
  });
  log("branch named", { issue: issue.identifier, repo: slug, branch: name, generated });
  return name;
}

/**
 * After a run, and before publishing: commit what's left uncommitted (`commitDirty`), move commits made
 * on a default branch or a detached HEAD onto a branch, rename branches that aren't publishable
 * (pennyworth/…, internal words), and sign the agent's commits. Returns notes for the report.
 */
async function tidyBranches(issue, workspace, { commitDirty, message }) {
  const notes = [];
  let committed = 0;
  for (const r of await workspaceRepos(workspace)) {
    const base = await defaultBranch(r.path);
    try {
      if (commitDirty) {
        for (const d of await dirtyCheckouts([r])) {
          if (!d.branch || d.branch === base) await git(d.path, "switch", "--quiet", "-c", await nameBranch(issue, { path: r.path, slug: r.slug, base, messages: [message] }));
          await git(d.path, "add", "-A");
          await git(d.path, "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", message);
          committed++;
        }
      }
      const onBase = await messagesSince(r.path, `origin/${base}`, base).catch(() => []);
      if (onBase.length) {
        const moved = await moveOffDefault(r.path, base, await nameBranch(issue, { path: r.path, slug: r.slug, base, messages: onBase }));
        if (moved) notes.push(`Commits made on \`${base}\` in ${r.slug} were moved to \`${moved}\`.`);
      }
      for (const b of await findBranches(r.path, { base, slug: r.slug, known: state.branches(issue.id).filter((k) => k.repo === r.slug).map((k) => k.branch) })) {
        if (b.branch === base || checkBranchName(b.branch, { base, defaultBranch: base }) || (await git(r.path, "ls-remote", "--heads", "origin", b.branch).catch(() => ""))) continue;
        const name = await nameBranch(issue, { path: r.path, slug: r.slug, base, messages: await messagesSince(r.path, `origin/${base}`, b.branch) });
        await git(r.path, "branch", "-m", b.branch, name);
        state.deleteBranch(issue.id, r.slug, b.branch);
        notes.push(`Renamed \`${b.branch}\` to \`${name}\` in ${r.slug}.`);
      }
      await signUnsigned(r.path);
    } catch (err) {
      log("tidy failed", { issue: issue.identifier, repo: r.slug, err: String(err.stderr || err.message || err).slice(0, 300) });
      notes.push(`Couldn't finish tidying ${r.slug}'s branches: ${String(err.stderr || err.message || err).trim().split("\n").pop().slice(0, 200)}`);
    }
  }
  return { notes, committed };
}

/** Every local branch tip in the workspace, as one string: compared before and after a run. */
async function branchTips(workspace) {
  const out = [];
  for (const r of await workspaceRepos(workspace)) out.push(`${r.slug}\n${await git(r.path, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads").catch(() => "")}`);
  return out.join("\n");
}

/**
 * The task's branches now, saved to the state (D-41): every local branch with commits of its own in
 * every workspace repository, with what GitHub doesn't have yet. Rows of branches that disappeared
 * are dropped unless they were pushed.
 */
async function branchRows(issue, workspace) {
  const manifest = readManifest(workspace);
  const rows = [];
  const repos = await workspaceRepos(workspace);
  for (const r of repos) {
    const base = await defaultBranch(r.path);
    const found = await findBranches(r.path, { base, manifest, slug: r.slug, known: state.branches(issue.id).filter((k) => k.repo === r.slug).map((k) => k.branch) });
    for (const b of found) state.saveBranch(issue.id, { repo: r.slug, branch: b.branch, base: b.base, purpose: b.purpose });
    for (const k of state.branches(issue.id).filter((k) => k.repo === r.slug && !found.some((b) => b.branch === k.branch))) {
      if (!k.pushed && !k.pr_url) state.deleteBranch(issue.id, k.repo, k.branch);
    }
    const taskBranches = state.branches(issue.id).filter((k) => k.repo === r.slug).map((k) => k.branch);
    for (const b of state.branches(issue.id).filter((k) => k.repo === r.slug)) {
      if (!(await git(r.path, "rev-parse", "--verify", "--quiet", `refs/heads/${b.branch}`).catch(() => ""))) continue;
      const c = await branchChanges(r.path, { branch: b.branch, base: b.base, taskBranches });
      rows.push({ repo: r.slug, path: r.path, branch: b.branch, base: b.base, baseRef: await baseRef(r.path, { branch: b.branch, base: b.base, taskBranches }), defaultBase: base, purpose: b.purpose, unpublished: c.unpublished, stat: c.stat, onGitHub: c.onGitHub, pushed: b.pushed, prUrl: b.pr_url ?? undefined, merged: b.merged, writable: writable(r.slug), readOnly: !writable(r.slug) });
    }
  }
  return rows;
}

/** Commit subjects are public: never let a task number or our tooling into one. */
const publicSubject = (subject) => (leaksInternal(subject) ? "chore: update" : subject);

/** Last few lines of a job log, without terminal colour codes (for failure reports). */
function logTail(path, lines = 6) {
  try {
    return readFileSync(path, "utf8").replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").filter((l) => !l.startsWith("#")).slice(-lines).join("\n").slice(-1500) || "(empty)";
  } catch {
    return "(log unavailable)";
  }
}

async function lastReport(issueId) {
  const comments = [...(await pc.comments(issueId))].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return latestReport(comments.map((c) => c.body), RUNNER_MARKER);
}

/** The newest report or answer on a task: what the user's reply is about. */
async function lastResultOf(issueId) {
  const comments = [...(await pc.comments(issueId))].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return latestResult(comments.map((c) => c.body), RUNNER_MARKER);
}

/**
 * PRs of the task's branches that were merged or closed since we last looked. A closed one is
 * forgotten, so "pr" opens a new one. A merged one stays as merged; commits made on its branch after
 * the merge move to a new branch from the latest default branch. Returns sentences for the user.
 */
async function leaveFinishedPrs(issue, workspace) {
  const notes = [];
  const repos = await workspaceRepos(workspace);
  for (const b of state.branches(issue.id).filter((b) => b.pr_url && !b.merged)) {
    let pr;
    try {
      const { stdout } = await execFileP(await findRealGh(), ["pr", "view", b.pr_url, "--json", "state,number,headRefOid"]);
      pr = JSON.parse(stdout);
    } catch (err) {
      log("pr state check failed", { issue: issue.identifier, err: String(err.stderr || err.message).slice(0, 300) });
      continue;
    }
    if (pr.state === "OPEN") continue;
    if (pr.state === "CLOSED") {
      state.updateBranch(issue.id, b.repo, b.branch, { pr_url: null });
      notes.push(`PR #${pr.number} (\`${b.branch}\`) was closed without merging, so **pr** will open a new one.`);
      continue;
    }
    state.updateBranch(issue.id, b.repo, b.branch, { merged: 1 });
    const r = repos.find((x) => x.slug === b.repo);
    if (!r) continue;
    const base = await defaultBranch(r.path);
    let note = `PR #${pr.number} (\`${b.branch}\`) is merged.`;
    try {
      const after = await git(r.path, "rev-list", "--count", `${pr.headRefOid}..${b.branch}`).catch(() => "0");
      if (Number(after)) {
        const next = await nameBranch(issue, { path: r.path, slug: r.slug, base, messages: await messagesSince(r.path, pr.headRefOid, b.branch) });
        const carried = await carryOver(r.path, { branch: b.branch, base, since: pr.headRefOid, name: next });
        note += ` The ${carried} commit${carried === 1 ? "" : "s"} made on it since moved to a new branch \`${next}\` from the latest \`${base}\`.`;
      }
    } catch (err) {
      note += ` The commits made on it since don't apply cleanly on the latest \`${base}\`, so they're still on \`${b.branch}\`. Git said: ${String(err.stderr || err.message).trim().split("\n").pop().slice(0, 200)}`;
    }
    log("pr merged", { issue: issue.identifier, pr: pr.number, branch: b.branch });
    notes.push(note);
  }
  return notes;
}

/** True when the task has commits on a branch (something to push or open a PR for). */
async function taskHasCommits(task) {
  if (task?.worktree && task.base) return Boolean((await changesSummary(task.worktree, task.base).catch(() => ({}))).commits);
  if (!task?.workspace || !existsSync(task.workspace)) return false;
  for (const r of await workspaceRepos(task.workspace)) if ((await findBranches(r.path, { base: await defaultBranch(r.path), known: state.branches(task.issue_id).filter((k) => k.repo === r.slug).map((k) => k.branch) }).catch(() => [])).length) return true;
  return false;
}

async function findRealGh() {
  const { stdout } = await execFileP("sh", ["-c", "command -v gh"], { env: { ...process.env } });
  return stdout.trim();
}

async function reportError(issue, err) {
  const userFacing = err instanceof UserError || /not allowed|Which repository|Several repositories|unknown (engine|mode|devshell)|isn't set up/.test(String(err.message));
  log("error", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 500) });
  try {
    await pc.comment(issue.id, userFacing ? err.message : `Runner error: \`${String(err.message ?? err).slice(0, 400)}\``);
  } catch {
    /* Paperclip unavailable: logged above */
  }
}

// ------------------------------------------------------------------ main

const interrupted = state.interruptStale();
if (interrupted) log("marked interrupted jobs from a previous run", { interrupted });
log("runner started", { config: cfg.file, label: cfg.label, orgs: cfg.allowed_orgs, poll_seconds: cfg.poll_seconds });

let stopping = false;
async function loop() {
  while (!stopping) {
    try {
      await poll();
    } catch (err) {
      log("poll failed", { err: String(err.message ?? err).slice(0, 300) });
    }
    await new Promise((r) => setTimeout(r, (cfg.poll_seconds ?? 20) * 1000));
  }
}
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    stopping = true;
    for (const { controller } of running.values()) controller.abort();
    setTimeout(() => process.exit(0), 3000);
  });
}
void loop();
// The board's Agents view: on a timer, because a poll can take minutes (intake, GitHub checks).
reportActivity();
setInterval(reportActivity, 30_000);
