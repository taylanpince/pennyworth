import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export async function git(cwd, ...args) {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return stdout.trim();
}

/** Hooks dir whose pre-push always refuses: agents cannot push from task worktrees. */
function ensureGuardHooks(workDir) {
  const dir = join(workDir, ".guard-hooks");
  mkdirSync(dir, { recursive: true });
  const hook = join(dir, "pre-push");
  writeFileSync(hook, '#!/bin/sh\necho "push blocked: Pennyworth task worktrees are local-only. Comment \\"push\\" on the task to publish the branch." >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  return dir;
}

/**
 * Runner-owned clone of org/repo (never the user's working copies), refreshed before
 * every job, with pushing disabled at the repository level.
 */
export async function ensureClone(workDir, repo) {
  const path = join(workDir, "repos", repo.org, repo.name);
  if (!existsSync(join(path, ".git"))) {
    mkdirSync(join(workDir, "repos", repo.org), { recursive: true });
    await run("git", ["clone", "--quiet", `git@github.com:${repo.slug}.git`, path], { maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  }
  await git(path, "fetch", "--quiet", "--prune", "origin");
  await git(path, "config", "remote.origin.pushurl", "DISABLED_BY_PENNYWORTH");
  await git(path, "config", "core.hooksPath", ensureGuardHooks(workDir));
  return path;
}

export async function defaultBranch(clone) {
  try {
    return (await git(clone, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).replace(/^origin\//, "");
  } catch {
    try {
      await git(clone, "remote", "set-head", "origin", "--auto");
      return (await git(clone, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).replace(/^origin\//, "");
    } catch {
      return "main"; // empty repository: nothing on GitHub yet
    }
  }
}

const hasRef = (cwd, ref) => git(cwd, "rev-parse", "--verify", "--quiet", ref).then(() => true, () => false);

/** Bring a reference repository's checkout up to date with origin (read-only context for the agent). */
export async function refreshCheckout(clone) {
  const base = await defaultBranch(clone);
  if (await hasRef(clone, `origin/${base}`)) await git(clone, "checkout", "--quiet", "--detach", `origin/${base}`);
  return clone;
}

/** One worktree per task on branch pennyworth/<task>, created from origin/<base>. */
export async function ensureWorktree(workDir, clone, identifier, repo, branch, base) {
  const path = join(workDir, "tasks", `${identifier}-${repo.name}`);
  if (existsSync(join(path, ".git"))) return path;
  mkdirSync(join(workDir, "tasks"), { recursive: true });
  const exists = await git(clone, "branch", "--list", branch);
  if (exists) await git(clone, "worktree", "add", "--quiet", path, branch);
  else if (await hasRef(clone, `origin/${base}`)) await git(clone, "worktree", "add", "--quiet", "-b", branch, path, `origin/${base}`);
  else await git(clone, "worktree", "add", "--quiet", "--orphan", "-b", branch, path); // empty repository
  return path;
}

export async function removeWorktree(clone, worktree) {
  if (existsSync(worktree)) await git(clone, "worktree", "remove", "--force", worktree);
}

export async function changesSummary(worktree, base) {
  // An empty repository has no origin/<base>: everything on the branch is new.
  const empty = !(await hasRef(worktree, `origin/${base}`));
  const commits = await git(worktree, "log", "--oneline", ...(empty ? ["HEAD"] : [`origin/${base}..HEAD`])).catch(() => "");
  const stat = await git(worktree, "diff", "--stat", ...(empty ? [EMPTY_TREE, "HEAD"] : [`origin/${base}...HEAD`])).catch(() => "");
  const dirty = await git(worktree, "status", "--porcelain").catch(() => "");
  return { commits, stat, dirty };
}

/** True when the task branch exists on GitHub (used to detect pushes the runner did not make). */
export async function remoteHasBranch(clone, branch) {
  const out = await git(clone, "ls-remote", "--heads", "origin", branch).catch(() => "");
  return out.length > 0;
}

/** The commit a branch points to on GitHub, or "" when it doesn't exist there. */
export async function remoteBranchHead(clone, branch) {
  return (await git(clone, "ls-remote", "--heads", "origin", branch)).split(/\s/)[0] ?? "";
}

/** True when the repository on GitHub has no branches at all (a freshly created, empty repo). */
export async function remoteIsEmpty(clone) {
  return (await git(clone, "ls-remote", "--heads", "origin")).length === 0;
}

/**
 * Human-approved publish: push the task branch with the real URL, never force. Into an empty
 * repository the work goes to the default branch instead (`main`), because the first branch
 * pushed to an empty GitHub repo becomes its default branch.
 */
export async function pushBranch(clone, worktree, branch, { initialBranch } = {}) {
  const url = await git(clone, "remote", "get-url", "origin");
  const target = initialBranch && (await remoteIsEmpty(clone)) ? initialBranch : branch;
  await git(worktree, "push", "--no-verify", url, `HEAD:refs/heads/${target}`);
  if (target !== branch) await git(clone, "fetch", "--quiet", "origin");
  return target;
}

export function detectShells(worktree, detect) {
  const shells = [];
  for (const [file, shell] of Object.entries(detect)) if (existsSync(join(worktree, file)) && !shells.includes(shell)) shells.push(shell);
  return shells;
}

/**
 * Move a task worktree onto a new branch from the latest origin/<base>, carrying over the commits
 * made after `since` (the merged PR's last head). Commits that are already merged therefore never
 * reappear, whether the PR was merged, squashed or rebased. Returns the number of commits carried.
 * On a conflict the worktree is put back on its old branch and the new one is deleted.
 */
export async function startFreshBranch(clone, worktree, { base, since, branch }) {
  await git(clone, "fetch", "--quiet", "--prune", "origin");
  const old = await git(worktree, "rev-parse", "--abbrev-ref", "HEAD");
  const range = (await hasRef(worktree, `${since}^{commit}`)) ? `${since}..HEAD` : `origin/${base}..HEAD`;
  const carry = (await git(worktree, "rev-list", "--reverse", "--no-merges", range)).split("\n").filter(Boolean);
  await git(worktree, "switch", "--quiet", "-c", branch, `origin/${base}`);
  try {
    for (const sha of carry) await git(worktree, "-c", "core.hooksPath=/dev/null", "cherry-pick", "--allow-empty", sha);
  } catch (err) {
    await git(worktree, "cherry-pick", "--abort").catch(() => {});
    await git(worktree, "switch", "--quiet", old);
    await git(worktree, "branch", "-D", branch);
    throw err;
  }
  return carry.length;
}

/** Next free branch name for a task: <root>-2, -3, … (free locally and on GitHub). */
export async function nextBranchName(clone, root) {
  for (let n = 2; ; n++) {
    const name = `${root}-${n}`;
    if (!(await git(clone, "branch", "--list", name)) && !(await remoteHasBranch(clone, name))) return name;
  }
}
