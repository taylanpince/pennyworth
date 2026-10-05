#!/usr/bin/env node
// Pennyworth runner: turns your comments on Paperclip tasks labelled "engineer" into
// Codex / OpenRouter coding jobs in runner-owned git worktrees on this machine.
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { branchFor, findRepos, normalizeRepo, parseComment, repoAllowed, resolveEngine, resolveMode, resolveShells } from "./commands.mjs";
import { loadConfig } from "./config.mjs";
import { runAgent } from "./engines.mjs";
import { changesSummary, defaultBranch, detectShells, ensureClone, ensureWorktree, git, pushBranch, refreshCheckout, remoteHasBranch, removeWorktree } from "./git.mjs";
import { codexModels, readRequest, resolveModelAlias } from "./intake.mjs";
import { Paperclip } from "./paperclip.mjs";
import { commitMessage, firstPrompt, followUpPrompt, stripCommitLine } from "./prompt.mjs";
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
const engineLabel = (e) => (e.kind === "codex" ? `Codex${e.model ? ` (${e.model})` : ""}` : `OpenRouter ${e.model}`);

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
    // Newly assigned to the Engineer and nobody has said anything yet: say so, once.
    if (engineerId && issue.assigneeAgentId === engineerId && !userComments.length && !state.get(`greeted:${issue.id}`) && !running.has(issue.id)) {
      state.set(`greeted:${issue.id}`, new Date().toISOString());
      await pc.comment(issue.id, "Ready. Tell me in a comment what you'd like done and which repository to work in.");
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
  const job = { issue, directives, instructions: instructions.join("\n\n") };
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
  if (directives.model) directives.model = resolveModelAlias(directives.model, codexModels()) ?? directives.model;
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
    const branch = task.branch ?? branchFor(issue.identifier);
    const worktree = await ensureWorktree(cfg.workDir, clone, issue.identifier, repo, branch, base);
    // Devshells: an explicit "shells:" wins, then the ones chosen for this task earlier, then detection.
    const shells = directives.shells || !task.shells ? resolveShells(directives, detectShells(worktree, cfg.devshells.detect), instructions, cfg) : task.shells;
    state.updateTask(issue.id, { base, branch, worktree, shells, engine, mode });

    const logPath = join(logsDir, `${issue.identifier}-${Date.now()}.log`);
    jobId = state.startJob(issue.id, engineLabel(engine), logPath);
    running.get(issue.id).jobId = jobId;
    const resumed = Boolean(task.session_id && task.engine?.kind === engine.kind);
    const refsNote = references.length ? `, reading ${references.map((r) => `\`${r.slug}\``).join(", ")} for reference` : "";
    await pc.startWork(
      issue.id,
      `${resumed ? "Continuing" : "On it"}: ${mode === "implement" ? "making the change" : "investigating"} in \`${repo.slug}\`${refsNote}, with ${engineLabel(engine)}. I'll post the result here.\n\n_Branch \`${branch}\` · worktree \`${worktree}\` · shells ${shells.join(", ")}_`,
    );
    log("job started", { issue: issue.identifier, repo: repo.slug, engine: engine.kind, mode, resumed });

    const prompt = resumed
      ? followUpPrompt({ user: cfg.selfName, mode, instructions })
      : firstPrompt({ user: cfg.selfName, task: full, repo, worktree, branch, base, mode, shells, instructions, references });
    const result = await runAgent({ cfg, engine, shells, worktree, prompt, sessionId: resumed ? task.session_id : undefined, logPath, signal: controller.signal });
    if (result.sessionId) state.updateTask(issue.id, { session_id: result.sessionId });

    if (result.cancelled) {
      state.finishJob(jobId, "cancelled");
      await pc.setStatus(issue.id, "in_review", "Stopped on request. The worktree is unchanged since the last run report.");
      return;
    }

    // Implement mode: the runner commits what the agent changed.
    let committed = "";
    const summaryBefore = await changesSummary(worktree, base);
    if (mode === "implement" && summaryBefore.dirty) {
      await git(worktree, "add", "-A");
      await git(worktree, "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", commitMessage(result.lastMessage, `chore: ${full.title}`), "-m", `Paperclip task: ${issue.identifier}`);
      committed = "yes";
    }
    const changes = await changesSummary(worktree, base);
    const unexpectedPush = !task.pushed && (await remoteHasBranch(clone, branch));

    const report = stripCommitLine(result.lastMessage) || "_The agent produced no report. See the run log._";
    const parts = [
      result.timedOut ? `**Timed out** after ${cfg.timeout_minutes ?? 60} minutes. Partial results below.\n` : "",
      result.code && !result.timedOut ? `**The agent exited with code ${result.code}.** See the log for details.\n` : "",
      report,
      "",
      "---",
      `${engineLabel(engine)} · ${mode} · \`${repo.slug}\` · branch \`${branch}\` (from \`${base}\`)`,
    ];
    if (changes.commits) parts.push(`\n**Commits on the task branch**\n\`\`\`\n${changes.commits}\n\`\`\`\n\`\`\`\n${changes.stat}\n\`\`\``);
    if (mode === "investigate" && summaryBefore.dirty) parts.push("\n_Note: the investigation left uncommitted changes in the worktree._");
    if (changes.commits) parts.push("\nReply **push** to publish the branch to GitHub, or **pr** to also open a draft PR.");
    parts.push(`Worktree: \`${worktree}\` · log: \`${logPath}\``);
    if (unexpectedPush) parts.push(`\n⚠️ **The branch \`${branch}\` exists on GitHub but the runner did not push it.** Please check.`);
    await pc.setStatus(issue.id, result.code || result.timedOut ? "blocked" : "in_review", parts.filter(Boolean).join("\n"));
    state.finishJob(jobId, result.timedOut ? "timeout" : result.code ? "failed" : "done", committed ? "committed" : undefined);
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
  const { commits } = await changesSummary(task.worktree, task.base);
  if (!commits) return void (await pc.comment(issue.id, "The task branch has no commits to publish."));
  if (command === "push" || (command === "pr" && !task.pushed)) {
    if (!task.branch?.startsWith("pennyworth/")) throw new Error(`refusing to push unexpected branch ${task.branch}`);
    await pushBranch(clone, task.worktree, task.branch);
    state.updateTask(issue.id, { pushed: 1 });
    log("branch pushed", { issue: issue.identifier, repo: repo.slug, branch: task.branch });
    if (command === "push") {
      return void (await pc.comment(issue.id, `Pushed \`${task.branch}\` → https://github.com/${repo.slug}/compare/${task.base}...${encodeURIComponent(task.branch)}?expand=1`));
    }
  }
  if (command === "pr") {
    if (task.pr_url) return void (await pc.comment(issue.id, `PR already open: ${task.pr_url} (pushed the latest commits).`));
    const full = await pc.issue(issue.id);
    const body = `Draft opened by Pennyworth for Paperclip task ${issue.identifier}.\n\n${(await lastReport(issue.id)) ?? ""}`.slice(0, 60_000);
    const realGh = await findRealGh();
    const { stdout } = await execFileP(realGh, ["pr", "create", "--draft", "--repo", repo.slug, "--head", task.branch, "--base", task.base, "--title", full.title.slice(0, 200), "--body", body], { cwd: task.worktree });
    const url = stdout.trim().split("\n").pop();
    state.updateTask(issue.id, { pr_url: url });
    log("draft PR opened", { issue: issue.identifier, url });
    await pc.comment(issue.id, `Opened draft PR: ${url}`);
  }
}

async function lastReport(issueId) {
  const comments = await pc.comments(issueId);
  const mine = comments.filter((c) => c.body?.includes("<!-- pennyworth-runner -->") && c.body.includes("## Summary"));
  return mine.at(-1)?.body.replace(/<!--[\s\S]*?-->/g, "").split("\n---\n")[0].trim();
}

async function findRealGh() {
  const { stdout } = await execFileP("sh", ["-c", "command -v gh"], { env: { ...process.env } });
  return stdout.trim();
}

async function reportError(issue, err) {
  const userFacing = err instanceof UserError || /not allowed|Which repository|Several repositories|unknown (engine|mode|devshell)/.test(String(err.message));
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
