#!/usr/bin/env node
// Pennyworth runner: turns your comments on Paperclip tasks labelled "engineer" into
// Codex / Claude Code / OpenRouter coding jobs in runner-owned git worktrees on this machine.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { RUNNER_MARKER, branchFor, isAgentSubtask, ownRequest, findRepos, isClaudeModel, normalizeRepo, parseCommand, pickedEngine, pickerFor, repoAllowed, resolveEngine, resolveMode, resolveShells, stripHidden } from "./commands.mjs";
import { loadConfig } from "./config.mjs";
import { runAgent } from "./engines.mjs";
import { changesSummary, defaultBranch, detectShells, ensureClone, ensureWorktree, git, pushBranch, refreshCheckout, remoteBranchHead, remoteHasBranch, remoteIsEmpty, removeWorktree, startFreshBranch, nextBranchName } from "./git.mjs";
import { codexModels, readApproval, readRequest, resolveModelAlias } from "./intake.mjs";
import { Paperclip } from "./paperclip.mjs";
import { cleanMessages, leaksInternal, writePrDescription } from "./describe.mjs";
import { commitMessage, firstPrompt, followUpPrompt, latestReport, prSummary, prTitle, publishFooter, subtaskSummary, runOutcome, stripAnswerHeading, stripCommitLine } from "./prompt.mjs";
import { ACTIVITY_QUERY, Board, activityComment, activitySearches, formatRepo } from "./recurring.mjs";
import { PR_QUERY, reviewOutcome, reviewTarget } from "./reviews.mjs";
import { State } from "./state.mjs";

const execFileP = promisify(execFile);
const cfg = loadConfig();
const pc = new Paperclip(cfg);
const state = new State(cfg.stateDir);
const logsDir = join(cfg.stateDir, "logs");
mkdirSync(logsDir, { recursive: true, mode: 0o700 });

const running = new Map(); // issueId → { controller, jobId }
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
  state.set("last_poll", now);
  drainQueue();
}

// ------------------------------------------------------------------ recurring tasks (D-25)

let lastRecurringCheck = 0;
const board = cfg.recurring?.enabled === false ? undefined : (() => {
  try {
    return new Board(cfg.boardInternalUrl, cfg.boardTokenFile);
  } catch (err) {
    log("recurring tasks off: no board token", { err: String(err.message ?? err).slice(0, 200) });
    return undefined;
  }
})();

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

  const candidates = findRepos(`${instructions}\n${full.title}\n${full.description ?? ""}`, cfg.allowed_orgs).map((r) => r.slug);
  const before = state.task(issue.id);
  const busy = running.has(issue.id) || queue.some((j) => j.issue.id === issue.id);
  const hasWork = await taskHasCommits(before);
  const read = await readRequest({ cfg, user: cfg.selfName, title: full.title, description: full.description, instructions, latest, candidates, known: before.repo, previousMode: before.mode, busy, hasWork, lastResult: await lastReport(issue.id).catch(() => undefined) })
    .catch((err) => (log("intake failed", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 300) }), undefined));
  // Publishing needs something to publish: "build X and prepare a PR" on a fresh task is a run.
  const action = (read?.action === "push" || read?.action === "pr") && !hasWork ? "run" : (read?.action ?? "run");
  log("request read", { issue: issue.identifier, action, mode: read?.mode });

  if (["stop", "status", "reset", "cleanup"].includes(action)) {
    if (action === "stop") {
      const before = queue.length;
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].issue.id === issue.id) queue.splice(i, 1);
      if (!running.has(issue.id) && queue.length < before) return void (await pc.comment(issue.id, "Cancelled the queued request. Nothing else was running."));
    }
    return runCommand(issue, state.task(issue.id), action);
  }
  if (action === "push" || action === "pr") {
    const what = action === "push" ? "publish the task branch to GitHub" : "push the task branch and open a draft PR";
    return void (await pc.comment(issue.id, `To ${what}, reply with just **${action}**. I only publish on that exact word.`));
  }
  return dispatch({ issue, instructions, read, candidates, full });
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
    if (!repoAllowed(repo, cfg.allowed_orgs)) throw new UserError(`Repository \`${settings.repo}\` is not allowed (allowed orgs: ${cfg.allowed_orgs.join(", ")}).`);
    if (task.repo && task.repo !== repo.slug) throw new UserError(`This task already works on \`${task.repo}\`. Use a separate task for another repository.`);
    fields.repo = repo.slug;
  }
  if (settings.base) fields.base = settings.base.trim();
  if (settings.model && !isClaudeModel(settings.model)) settings.model = resolveModelAlias(settings.model, codexModels()) ?? settings.model;
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

class UserError extends Error {}

async function startJob({ issue, instructions, read, candidates }) {
  const controller = new AbortController();
  running.set(issue.id, { controller });
  let jobId;
  try {
    const full = await pc.issue(issue.id);
    const pendingKey = `pending:${issue.id}`;
    // Settings from the intake's reading of the request (handleRequest), checked in applyDirectives.
    const before = state.task(issue.id);
    const inferred = {};
    if (read?.repo && !before.repo) inferred.repo = read.repo;
    inferred.mode = read?.mode ?? "investigate"; // judged per request; if unreadable, change nothing
    if (read?.engine === "glm") inferred.engine = "glm";
    else if (read?.engine === "claude") Object.assign(inferred, { engine: "claude" }, read.model ? { model: read.model } : {});
    else if (read?.model) Object.assign(inferred, { engine: "codex", model: read.model });
    let task = await applySettings(issue, before, inferred);
    task = await syncPicker(issue, full, task, Boolean(inferred.engine || inferred.model));

    if (!task.repo) {
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
    // Reference repositories (read-only context), remembered for follow-ups.
    const refsKey = `refs:${issue.id}`;
    const refSlugs = [...new Set([...JSON.parse(state.get(refsKey) || "[]"), ...(read?.references ?? [])])].filter((r) => r.toLowerCase() !== task.repo.toLowerCase());
    state.set(refsKey, JSON.stringify(refSlugs));
    const references = [];
    for (const slug of refSlugs) {
      try {
        references.push({ slug, path: await refreshCheckout(await ensureClone(cfg.workDir, normalizeRepo(slug))) });
      } catch (err) {
        log("reference clone failed", { issue: issue.identifier, repo: slug, err: String(err.message ?? err).slice(0, 300) });
      }
    }
    const repo = normalizeRepo(task.repo);
    const engine = task.engine ?? resolveEngine({}, cfg);
    const mode = task.mode ?? "investigate";

    const clone = await ensureClone(cfg.workDir, repo);
    const base = task.base ?? (await defaultBranch(clone));
    let branch = task.branch ?? branchFor(issue.identifier);
    const worktree = await ensureWorktree(cfg.workDir, clone, issue.identifier, repo, branch, base);
    // The task's PR may have been merged or closed since the last run: never keep working on it.
    const prNote = await leaveFinishedPr(issue, { ...task, base, branch, worktree }, clone);
    if (prNote) {
      task = state.task(issue.id);
      branch = task.branch;
      instructions = `(Runner note: ${prNote} Build on what is there now.)\n\n${instructions}`;
    }
    // Devshells: an explicit "shells:" wins, then the ones chosen for this task earlier, then detection.
    const shells = task.shells ?? resolveShells({}, detectShells(worktree, cfg.devshells.detect), instructions, cfg);
    state.updateTask(issue.id, { base, branch, worktree, shells, engine, mode });

    const logPath = join(logsDir, `${issue.identifier}-${Date.now()}.log`);
    jobId = state.startJob(issue.id, engineLabel(engine), logPath);
    running.get(issue.id).jobId = jobId;
    // A saved session can only be continued by the engine that created it (Codex, Claude Code and
    // opencode sessions are not interchangeable). After a switch the new engine starts fresh, with the
    // earlier requests on this task and the work already on the branch as context.
    const sessionEngine = state.get(`session_engine:${issue.id}`) || (String(task.session_id).startsWith("ses_") ? "openrouter" : "codex");
    const resumed = Boolean(task.session_id && sessionEngine === engine.kind);
    const historyKey = `history:${issue.id}`;
    const earlier = resumed ? "" : state.get(historyKey) || "";
    state.set(historyKey, `${state.get(historyKey) || ""}\n\n---\n\n${instructions}`.trim().slice(-20_000));
    const refsNote = references.length ? `, reading ${references.map((r) => `\`${r.slug}\``).join(", ")} for reference` : "";
    await pc.startWork(
      issue.id,
      mode === "answer"
        ? `Looking into your question in \`${repo.slug}\` with ${engineLabel(engine)}. I'll answer here.`
        : `${prNote && mode === "implement" ? `${prNote}\n\n` : ""}${resumed ? "Continuing" : "On it"}: ${mode === "implement" ? "making the change" : "investigating"} in \`${repo.slug}\`${refsNote}, with ${engineLabel(engine)}. I'll post the result here.\n\n_Branch \`${branch}\` · worktree \`${worktree}\` · shells ${shells.join(", ")}_`,
    );
    log("job started", { issue: issue.identifier, repo: repo.slug, engine: engine.kind, mode, resumed });

    const prompt = resumed
      ? followUpPrompt({ user: cfg.selfName, mode, instructions })
      : firstPrompt({ user: cfg.selfName, task: full, repo, worktree, branch, base, mode, shells, instructions, references, earlier });
    const result = await runAgent({ cfg, engine, shells, worktree, prompt, sessionId: resumed ? task.session_id : undefined, logPath, signal: controller.signal });
    if (result.sessionId) {
      state.updateTask(issue.id, { session_id: result.sessionId });
      state.set(`session_engine:${issue.id}`, engine.kind);
    }

    if (result.cancelled) {
      state.finishJob(jobId, "cancelled");
      await pc.setStatus(issue.id, "in_review", "Stopped on request. The worktree is unchanged since the last run report.");
      return;
    }

    // Implement mode: the runner commits what the agent changed, but only after a finished run.
    let committed = "";
    const summaryBefore = await changesSummary(worktree, base);
    const outcome = runOutcome({ ...result, timeoutMinutes: cfg.timeout_minutes ?? 60, mode, dirty: Boolean(summaryBefore.dirty) });
    if (mode === "implement" && summaryBefore.dirty && outcome.finished) {
      await git(worktree, "add", "-A");
      await git(worktree, "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", publicSubject(commitMessage(result.lastMessage, `chore: ${full.title}`)));
      committed = "yes";
    }
    const changes = await changesSummary(worktree, base);
    const unexpectedPush = !task.pushed && (await remoteHasBranch(clone, branch));

    const report = stripCommitLine(result.lastMessage);
    if (mode === "answer" && outcome.finished) {
      await pc.setStatus(issue.id, "in_review", `${stripAnswerHeading(report)}\n\n_${engineLabel(engine)} · \`${repo.slug}\`${summaryBefore.dirty ? " · note: the worktree has uncommitted changes" : ""}_`);
      state.finishJob(jobId, "done");
      log("job finished", { issue: issue.identifier, code: result.code, mode });
      return;
    }
    const parts = [
      outcome.headline,
      outcome.finished ? "" : `\nLast lines of the log:\n\`\`\`\n${logTail(logPath)}\n\`\`\`${report ? `\n\nThe agent's last message:\n\n> ${report.slice(0, 1500).replace(/\n/g, "\n> ")}` : ""}`,
      outcome.finished ? `\n${report}` : "",
      "",
      "---",
      `${engineLabel(engine)} · ${mode} · \`${repo.slug}\` · branch \`${branch}\` (from \`${base}\`)`,
    ];
    if (changes.commits) {
      // Only commits GitHub doesn't have yet are new; the rest is already on the branch or in the PR.
      const remoteHead = await remoteBranchHead(clone, branch).catch(() => "");
      const since = remoteHead && (await git(worktree, "cat-file", "-e", `${remoteHead}^{commit}`).then(() => true, () => false)) ? remoteHead : "";
      const unpublished = since ? await git(worktree, "log", "--oneline", `${since}..HEAD`).catch(() => changes.commits) : changes.commits;
      const stat = since ? (unpublished ? await git(worktree, "diff", "--stat", `${since}..HEAD`).catch(() => "") : "") : changes.stat;
      parts.push(publishFooter({ unpublished, stat, prUrl: state.task(issue.id).pr_url, onGitHub: Boolean(remoteHead) }));
    }
    if (mode !== "implement" && summaryBefore.dirty) parts.push("\n_Note: the worktree has uncommitted changes._");
    parts.push(`Worktree: \`${worktree}\` · log: \`${logPath}\``);
    if (unexpectedPush) parts.push(`\n⚠️ **The branch \`${branch}\` exists on GitHub but the runner did not push it.** Please check.`);
    // Failures also go to review (Paperclip refuses "blocked" without a blocker); the report says what failed.
    await pc.setStatus(issue.id, "in_review", parts.filter(Boolean).join("\n"));
    state.finishJob(jobId, result.timedOut ? "timeout" : result.code ? "failed" : outcome.finished ? "done" : "incomplete", committed ? "committed" : undefined);
    log("job finished", { issue: issue.identifier, code: result.code, timedOut: result.timedOut, committed: Boolean(committed) });
  } catch (err) {
    if (jobId) state.finishJob(jobId, "failed", String(err).slice(0, 500));
    await reportError(issue, err);
  } finally {
    running.delete(issue.id);
    drainQueue();
    void reportToParent(issue).catch((err) => log("parent summary failed", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 300) }));
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
  const kids = (await pc.children(parent.id)).filter((c) => isAgentSubtask(c) && state.get(`approved:${c.id}`));
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
      rows.push({ identifier: kid.identifier, title: kid.title, prUrl: note ? "" : state.task(kid.id)?.pr_url, note });
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
      task?.repo ? `Working in \`${task.repo}\` on branch \`${task.branch ?? "—"}\`${task.pr_url ? `, PR: ${task.pr_url}` : task.pushed ? " (pushed, no PR yet)" : " (not pushed yet)"}.` : "",
    ];
    return void (await pc.comment(issue.id, lines.filter(Boolean).join("\n")));
  }
  if (command === "reset") {
    state.updateTask(issue.id, { session_id: null });
    return void (await pc.comment(issue.id, "Session cleared: the next run starts a fresh agent conversation (the worktree and branch are kept)."));
  }
  if (!task?.worktree || !task.repo) {
    return void (await pc.comment(issue.id, `There's nothing to ${command === "pr" ? "open a PR for" : command} yet: no work has been done on this task. Tell me what to build and I'll start; ${command === "pr" ? "**pr**" : "**push**"} works once there are commits.`));
  }
  if (running.has(issue.id)) return void (await pc.comment(issue.id, `Can't ${command} while a run is in progress. Comment **stop** first, or wait for it to finish.`));
  const repo = normalizeRepo(task.repo);
  const clone = join(cfg.workDir, "repos", repo.org, repo.name);

  if (command === "cleanup") {
    if (await git(task.worktree, "status", "--porcelain").catch(() => "")) {
      return void (await pc.comment(issue.id, `I didn't remove the working copy: it has uncommitted changes (\`${task.worktree}\`). Ask me to commit or discard them first.`));
    }
    await removeWorktree(clone, task.worktree);
    state.updateTask(issue.id, { worktree: null, session_id: null });
    return void (await pc.comment(issue.id, `Removed the worktree. The local branch \`${task.branch}\` is kept${task.pushed ? " (and pushed)" : ""}.`));
  }
  const prNote = await leaveFinishedPr(issue, task, clone);
  if (prNote) task = state.task(issue.id);
  const { commits } = await changesSummary(task.worktree, task.base);
  if (!commits) return void (await pc.comment(issue.id, `${prNote ? `${prNote} ` : ""}There are no new commits to publish.`));
  if (command === "pr" && (await remoteIsEmpty(clone))) {
    return void (await pc.comment(issue.id, `The repository is still empty, so there's no branch to open a PR against. Reply **push** to publish this work as \`${task.base}\`.`));
  }
  // "pr" always pushes the task branch first: it may never have been pushed (the first push into an
  // empty repository goes to the base branch instead), and an open PR should get the latest commits.
  const head = await git(task.worktree, "log", "-1", "--format=%H %s");
  const upToDate = (await remoteBranchHead(clone, task.branch)) === head.split(" ")[0];
  if (command === "push" && upToDate) {
    return void (await pc.comment(
      issue.id,
      `**Nothing new to push.** GitHub already has the latest commit on \`${task.branch}\` (\`${head.slice(0, 7)}\` ${head.slice(41)})${task.pr_url ? `, and ${task.pr_url} shows it` : ""}. No commits have been made since the last push.`,
    ));
  }
  if (command === "push" || command === "pr") {
    if (!task.branch?.startsWith("pennyworth/")) throw new Error(`refusing to push unexpected branch ${task.branch}`);
    const target = await pushBranch(clone, task.worktree, task.branch, { initialBranch: task.base }).catch((err) => {
      throw new UserError(`I couldn't push \`${task.branch}\`. Git said:\n\`\`\`\n${String(err.stderr || err.message).trim().slice(-800)}\n\`\`\``);
    });
    state.updateTask(issue.id, { pushed: 1 });
    log("branch pushed", { issue: issue.identifier, repo: repo.slug, branch: target });
    if (command === "push") {
      if (prNote) await pc.comment(issue.id, prNote);
      return void (await pc.comment(
        issue.id,
        target === task.branch
          ? task.pr_url
            ? `Pushed \`${head.slice(0, 7)}\` ${head.slice(41)} to \`${task.branch}\`. The PR is updated: ${task.pr_url}`
            : `Pushed \`${task.branch}\` → https://github.com/${repo.slug}/compare/${task.base}...${encodeURIComponent(task.branch)}?expand=1`
          : `The repository was empty, so I pushed this as its first commit on \`${target}\` → https://github.com/${repo.slug}/tree/${encodeURIComponent(target)}\nLater changes on this task go to \`${task.branch}\` as usual.`,
      ));
    }
  }
  if (command === "pr") {
    if (task.pr_url) return void (await pc.comment(issue.id, upToDate ? `The PR is already open and up to date: ${task.pr_url}` : `Pushed the new commits to the open PR: ${task.pr_url}`));
    const full = await pc.issue(issue.id);
    // Written for the repository's reviewers: nothing about Pennyworth, tasks or this machine.
    const range = (await git(task.worktree, "rev-parse", "--verify", "--quiet", `origin/${task.base}`).then(() => true, () => false)) ? [`origin/${task.base}..HEAD`] : ["HEAD"];
    const messages = cleanMessages(await git(task.worktree, "log", "--reverse", "--format=%B%x1e", ...range).catch(() => ""));
    const diffRange = range[0] === "HEAD" ? ["4b825dc642cb6eb9a060e54bf8d69288fbee4904", "HEAD"] : [`origin/${task.base}...HEAD`];
    const stat = await git(task.worktree, "diff", "--stat", ...diffRange).catch(() => "");
    const diff = await git(task.worktree, "diff", ...diffRange).catch(() => "");
    const subject = messages.at(-1)?.split("\n")[0] ?? full.title;
    const fallbackTitle = prTitle(commits, leaksInternal(full.title) ? subject : full.title);
    const pr = await writePrDescription({
      cfg, repo: repo.slug, base: task.base,
      request: await prRequest(full),
      messages, stat, diff, report: await lastReport(issue.id).catch(() => undefined), fallbackTitle,
    });
    const body = leaksInternal(pr.body) ? "" : pr.body;
    log("pr description", { issue: issue.identifier, generated: pr.generated, rejected: Boolean(pr.rejected) });
    const realGh = await findRealGh();
    const { stdout } = await execFileP(realGh, ["pr", "create", "--draft", "--repo", repo.slug, "--head", task.branch, "--base", task.base, "--title", pr.title, "--body", body], { cwd: task.worktree }).catch((err) => {
      // gh's error message repeats the whole command line (PR body included): show stderr only.
      throw new UserError(`I couldn't open the PR. GitHub said:\n\`\`\`\n${String(err.stderr || "gh pr create failed").trim().slice(-800)}\n\`\`\``);
    });
    const url = stdout.trim().split("\n").pop();
    state.updateTask(issue.id, { pr_url: url });
    log("draft PR opened", { issue: issue.identifier, url });
    await pc.comment(issue.id, `${prNote ? `${prNote}\n\n` : ""}Opened draft PR: ${url}`);
  }
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

/**
 * If the task's PR was merged, move the work to a fresh branch from the latest base, carrying over
 * any commits made after the merge; if it was closed unmerged, forget it so "pr" opens a new one.
 * Returns a sentence for the user (empty when the PR is still open or there is none).
 */
async function leaveFinishedPr(issue, task, clone) {
  if (!task.pr_url || !task.worktree) return "";
  let pr;
  try {
    const { stdout } = await execFileP(await findRealGh(), ["pr", "view", task.pr_url, "--json", "state,number,headRefOid"]);
    pr = JSON.parse(stdout);
  } catch (err) {
    log("pr state check failed", { issue: issue.identifier, err: String(err.stderr || err.message).slice(0, 300) });
    return "";
  }
  if (pr.state === "OPEN") return "";
  if (pr.state === "CLOSED") {
    state.updateTask(issue.id, { pr_url: null });
    return `PR #${pr.number} was closed without merging, so **pr** will open a new one.`;
  }
  if (await git(task.worktree, "status", "--porcelain")) {
    throw new UserError(`PR #${pr.number} was merged, but the worktree has uncommitted changes, so I didn't move them to a new branch. Reply **cleanup** to start over from the latest \`${task.base}\`.`);
  }
  const next = await nextBranchName(clone, branchFor(issue.identifier));
  let carried;
  try {
    carried = await startFreshBranch(clone, task.worktree, { base: task.base, since: pr.headRefOid, branch: next });
  } catch (err) {
    throw new UserError(`PR #${pr.number} was merged, and the commits made since don't apply cleanly on the latest \`${task.base}\`. They are still on \`${task.branch}\`. Git said:\n\`\`\`\n${String(err.stderr || err.message).trim().slice(-600)}\n\`\`\``);
  }
  state.updateTask(issue.id, { branch: next, pr_url: null, pushed: 0 });
  log("moved off merged PR", { issue: issue.identifier, pr: pr.number, branch: next, carried });
  return `PR #${pr.number} is merged, so this work continues on a new branch \`${next}\` from the latest \`${task.base}\`${carried ? ` (${carried} commit${carried === 1 ? "" : "s"} made since the merge carried over)` : ""}.`;
}

/** True when the task has a worktree with commits on its branch (something to push or open a PR for). */
async function taskHasCommits(task) {
  if (!task?.worktree || !task.base) return false;
  return Boolean((await changesSummary(task.worktree, task.base).catch(() => ({}))).commits);
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
