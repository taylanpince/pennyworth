#!/usr/bin/env node
// Pennyworth runner: turns your comments on Paperclip tasks labelled "engineer" into
// Codex / Claude Code / OpenRouter coding jobs in runner-owned git worktrees on this machine.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { RUNNER_MARKER, branchFor, ownRequest, findRepos, isClaudeModel, normalizeRepo, parseComment, repoAllowed, resolveEngine, resolveMode, resolveShells } from "./commands.mjs";
import { loadConfig } from "./config.mjs";
import { runAgent } from "./engines.mjs";
import { changesSummary, defaultBranch, detectShells, ensureClone, ensureWorktree, git, pushBranch, refreshCheckout, remoteBranchHead, remoteHasBranch, remoteIsEmpty, removeWorktree, startFreshBranch, nextBranchName } from "./git.mjs";
import { codexModels, readRequest, resolveModelAlias } from "./intake.mjs";
import { Paperclip } from "./paperclip.mjs";
import { commitMessage, firstPrompt, followUpPrompt, latestReport, prTitle, runOutcome, stripCommitLine } from "./prompt.mjs";
import { State } from "./state.mjs";

const execFileP = promisify(execFile);
const cfg = loadConfig();
const pc = new Paperclip(cfg);
const state = new State(cfg.stateDir);
const logsDir = join(cfg.stateDir, "logs");
mkdirSync(logsDir, { recursive: true, mode: 0o700 });

const running = new Map(); // issueId → { controller, jobId }
const queue = []; // { issue, instructions, directives }
const log = (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const engineLabel = (e) =>
  e.kind === "codex" ? `Codex${e.model ? ` (${e.model})` : ""}` : e.kind === "claude" ? `Claude Code${e.model ? ` (${e.model})` : ""}` : `OpenRouter ${e.model}`;

// ------------------------------------------------------------------ polling

async function poll() {
  const since = state.get("last_poll");
  const now = new Date().toISOString();
  // Overlap the window so comments landing during a poll are never missed (handled IDs dedupe).
  const updatedSince = since ? new Date(Date.parse(since) - 120_000).toISOString() : undefined;
  // Tasks labelled "engineer" or assigned to the Engineer agent.
  const byId = new Map((await pc.labelledIssues(cfg.label, updatedSince)).map((i) => [i.id, i]));
  const engineer = await pc.engineerAgentId().catch(() => undefined);
  if (engineer) for (const i of await pc.assignedIssues(engineer, updatedSince)) byId.set(i.id, i);
  for (const issue of byId.values()) await handleIssue(issue, engineer).catch((err) => reportError(issue, err));
  // Replies: all of your open tasks (comments don't reliably bump "updated"), at most once a minute.
  if (cfg.replies?.enabled !== false && Date.now() - lastReplyCheck >= 60_000) {
    lastReplyCheck = Date.now();
    await dispatchReplies().catch((err) => log("reply dispatch failed", { err: String(err.message ?? err).slice(0, 300) }));
  }
  state.set("last_poll", now);
  drainQueue();
}

async function handleIssue(issue, engineerId) {
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
    // Newly assigned to the Engineer without comments. A task the user wrote themselves is the
    // request (its description); otherwise ask, once.
    if (engineerId && issue.assigneeAgentId === engineerId && !userComments.length && !running.has(issue.id) && !state.get(`greeted:${issue.id}`)) {
      state.set(`greeted:${issue.id}`, new Date().toISOString());
      if (ownRequest(await pc.issue(issue.id))) return dispatch({ issue, directives: {}, instructions: "" }); // startJob adds the description
      await pc.comment(issue.id, "Ready. What would you like me to do, and in which repository?");
    }
    return;
  }

  const instructions = [];
  let directives = {};
  for (const c of fresh) {
    state.markHandled(c.id, issue.id);
    const parsed = parseComment(c.body);
    if (parsed.command) {
      await runCommand(issue, state.task(issue.id), parsed.command);
      continue;
    }
    directives = { ...directives, ...parsed.directives };
    if (parsed.instructions) instructions.push(parsed.instructions);
  }
  if (!instructions.length && !Object.keys(directives).length) return;
  if (!instructions.length) {
    await applyDirectives(issue, task, directives);
    await pc.comment(issue.id, `Settings updated: ${Object.entries(directives).map(([k, v]) => `${k}=${v}`).join(", ")}. Comment with instructions to start a run.`);
    return;
  }
  return dispatch({ issue, directives, instructions: instructions.join("\n\n") });
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
    const fresh = (await pc.comments(issue.id)).filter((c) => Paperclip.isUserInstruction(c) && c.createdAt >= since && !state.handled(c.id));
    if (!fresh.length) continue;
    // Wait until the newest comment on this task is older than the debounce window.
    if (Date.now() - Date.parse(fresh.at(-1).createdAt) < debounceMs) continue;
    ready.push(issue.identifier);
    pending.push(...fresh.map((c) => [c.id, issue.id]));
  }
  if (!ready.length) return;
  await pc.runRoutine(r.routine ?? "Process task replies", { tasks: ready.join(", ") });
  for (const [cid, iid] of pending) state.markHandled(cid, iid);
  log("replies dispatched to Assistant", { tasks: ready });
}

function drainQueue() {
  while (running.size < (cfg.max_concurrent ?? 2)) {
    const i = queue.findIndex((j) => !running.has(j.issue.id));
    if (i < 0) return;
    void startJob(queue.splice(i, 1)[0]);
  }
}

// ------------------------------------------------------------------ jobs

async function applyDirectives(issue, task, directives) {
  const fields = {};
  if (directives.repo) {
    const repo = normalizeRepo(directives.repo);
    if (!repoAllowed(repo, cfg.allowed_orgs)) throw new UserError(`Repository \`${directives.repo}\` is not allowed (allowed orgs: ${cfg.allowed_orgs.join(", ")}).`);
    if (task.repo && task.repo !== repo.slug) throw new UserError(`This task already works on \`${task.repo}\`. Use a separate task for another repository.`);
    fields.repo = repo.slug;
  }
  if (directives.base) fields.base = directives.base.trim();
  if (directives.model && !isClaudeModel(directives.model)) directives.model = resolveModelAlias(directives.model, codexModels()) ?? directives.model;
  if (directives.engine || directives.model) fields.engine = resolveEngine(directives, cfg, task.engine);
  if (directives.mode) fields.mode = resolveMode(directives, task.mode);
  if (Object.keys(fields).length) state.updateTask(issue.id, fields);
  return state.task(issue.id);
}

class UserError extends Error {}

async function startJob({ issue, directives, instructions }) {
  directives = { ...directives };
  const controller = new AbortController();
  running.set(issue.id, { controller });
  let jobId;
  try {
    const full = await pc.issue(issue.id);
    // First run on a task the user wrote: its description is part of the request.
    if (!state.get(`history:${issue.id}`)) {
      const own = parseComment(ownRequest(full));
      if (own.instructions) {
        directives = { ...own.directives, ...directives };
        instructions = [`${full.title}\n\n${own.instructions}`, instructions].filter(Boolean).join("\n\n");
      }
    }
    // A request still waiting on an answer (e.g. which repository) is combined with the answer.
    const pendingKey = `pending:${issue.id}`;
    const pending = state.get(pendingKey);
    if (pending) instructions = `${pending}\n\n${instructions}`;

    // Plain-language request → settings. Explicit "key: value" lines still win.
    const candidates = findRepos(`${instructions}\n${full.title}\n${full.description ?? ""}`, cfg.allowed_orgs).map((r) => r.slug);
    const before = state.task(issue.id);
    const read = await readRequest({ cfg, user: cfg.selfName, title: full.title, description: full.description, instructions, candidates, known: before.repo })
      .catch((err) => (log("intake failed", { issue: issue.identifier, err: String(err.message ?? err).slice(0, 300) }), undefined));
    const inferred = {};
    if (read?.repo && !before.repo) inferred.repo = read.repo;
    if (read?.mode) inferred.mode = read.mode;
    if (read?.engine === "glm") inferred.engine = "glm";
    else if (read?.engine === "claude") Object.assign(inferred, { engine: "claude" }, read.model ? { model: read.model } : {});
    else if (read?.model) Object.assign(inferred, { engine: "codex", model: read.model });
    let task = await applyDirectives(issue, before, { ...inferred, ...directives });

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
    const shells = directives.shells || !task.shells ? resolveShells(directives, detectShells(worktree, cfg.devshells.detect), instructions, cfg) : task.shells;
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
      `${prNote ? `${prNote}\n\n` : ""}${resumed ? "Continuing" : "On it"}: ${mode === "implement" ? "making the change" : "investigating"} in \`${repo.slug}\`${refsNote}, with ${engineLabel(engine)}. I'll post the result here.\n\n_Branch \`${branch}\` · worktree \`${worktree}\` · shells ${shells.join(", ")}_`,
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
      await git(worktree, "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", commitMessage(result.lastMessage, `chore: ${full.title}`), "-m", `Paperclip task: ${issue.identifier}`);
      committed = "yes";
    }
    const changes = await changesSummary(worktree, base);
    const unexpectedPush = !task.pushed && (await remoteHasBranch(clone, branch));

    const report = stripCommitLine(result.lastMessage);
    const parts = [
      outcome.headline,
      outcome.finished ? "" : `\nLast lines of the log:\n\`\`\`\n${logTail(logPath)}\n\`\`\`${report ? `\n\nThe agent's last message:\n\n> ${report.slice(0, 1500).replace(/\n/g, "\n> ")}` : ""}`,
      outcome.finished ? `\n${report}` : "",
      "",
      "---",
      `${engineLabel(engine)} · ${mode} · \`${repo.slug}\` · branch \`${branch}\` (from \`${base}\`)`,
    ];
    if (changes.commits) parts.push(`\n**Commits on the task branch**\n\`\`\`\n${changes.commits}\n\`\`\`\n\`\`\`\n${changes.stat}\n\`\`\``);
    if (mode === "investigate" && summaryBefore.dirty) parts.push("\n_Note: the investigation left uncommitted changes in the worktree._");
    if (changes.commits) parts.push("\nReply **push** to publish the branch to GitHub, or **pr** to also open a draft PR.");
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
  }
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
    const r = running.get(issue.id);
    return void (await pc.comment(issue.id, `${r ? "A run is in progress." : "Idle."} Repo: \`${task?.repo ?? "—"}\`, branch: \`${task?.branch ?? "—"}\`, engine: ${task?.engine ? engineLabel(task.engine) : "default"}, mode: ${task?.mode ?? "investigate"}${task?.session_id ? ", session saved (follow-ups continue it)" : ""}.`));
  }
  if (command === "reset") {
    state.updateTask(issue.id, { session_id: null });
    return void (await pc.comment(issue.id, "Session cleared: the next run starts a fresh agent conversation (the worktree and branch are kept)."));
  }
  if (!task?.worktree || !task.repo) return void (await pc.comment(issue.id, "There is no worktree for this task yet."));
  if (running.has(issue.id)) return void (await pc.comment(issue.id, `Can't ${command} while a run is in progress. Comment **stop** first, or wait for it to finish.`));
  const repo = normalizeRepo(task.repo);
  const clone = join(cfg.workDir, "repos", repo.org, repo.name);

  if (command === "cleanup") {
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
    const body = `Draft opened by Pennyworth for Paperclip task ${issue.identifier}.\n\n${(await lastReport(issue.id)) ?? ""}`.trim().slice(0, 60_000);
    const realGh = await findRealGh();
    const { stdout } = await execFileP(realGh, ["pr", "create", "--draft", "--repo", repo.slug, "--head", task.branch, "--base", task.base, "--title", prTitle(commits, full.title), "--body", body], { cwd: task.worktree }).catch((err) => {
      // gh's error message repeats the whole command line (PR body included): show stderr only.
      throw new UserError(`I couldn't open the PR. GitHub said:\n\`\`\`\n${String(err.stderr || "gh pr create failed").trim().slice(-800)}\n\`\`\``);
    });
    const url = stdout.trim().split("\n").pop();
    state.updateTask(issue.id, { pr_url: url });
    log("draft PR opened", { issue: issue.identifier, url });
    await pc.comment(issue.id, `${prNote ? `${prNote}\n\n` : ""}Opened draft PR: ${url}`);
  }
}

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
