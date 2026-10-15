// Task workspaces (D-41): one directory per task, with a full clone of every repository the work
// touches. The agent branches and commits there as freely as in a person's own checkout; several
// branches, stacked branches and several repositories all live under one task. It cannot push:
// publishing stays with the runner, on the user's word. Clones are local copies of the runner's
// cache (hardlinked objects), so they are quick and keep every write inside the workspace.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRepo } from "./commands.mjs";
import { defaultBranch, git } from "./git.mjs";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MANIFEST = join(".pennyworth", "branches.json");

export const workspacePath = (workDir, identifier) => join(workDir, "tasks", identifier);

const hasRef = (cwd, ref) => git(cwd, "rev-parse", "--verify", "--quiet", ref).then(() => true, () => false);

/** The repositories cloned in a workspace: top-level directories that are git clones (not worktrees). */
export async function workspaceRepos(workspace) {
  if (!existsSync(workspace)) return [];
  const out = [];
  for (const name of readdirSync(workspace).sort()) {
    const path = join(workspace, name);
    if (name.startsWith(".") || !existsSync(join(path, ".git")) || !statSync(join(path, ".git")).isDirectory()) continue;
    const repo = normalizeRepo(await git(path, "config", "--get", "remote.origin.url").catch(() => ""));
    if (repo) out.push({ ...repo, path });
  }
  return out;
}

/**
 * Clone `repo` into the workspace from the runner's cache clone (`cache`), pointed at GitHub
 * (`remoteUrl`), on its default branch. An existing clone is fetched instead. Returns its path.
 */
export async function ensureRepo(workspace, repo, { cache, remoteUrl = `git@github.com:${repo.slug}.git`, hooksDir }) {
  mkdirSync(workspace, { recursive: true });
  const existing = (await workspaceRepos(workspace)).find((r) => r.slug.toLowerCase() === repo.slug.toLowerCase());
  if (existing) {
    await git(existing.path, "fetch", "--quiet", "--prune", "origin");
    return existing.path;
  }
  let path = join(workspace, repo.name);
  if (existsSync(path)) path = join(workspace, `${repo.org}--${repo.name}`);
  await git(workspace, "clone", "--quiet", "--no-checkout", cache, path);
  await git(path, "remote", "set-url", "origin", remoteUrl);
  // Pushing is the runner's job: the clone has no push URL and a pre-push hook that refuses.
  await git(path, "config", "remote.origin.pushurl", "DISABLED_BY_PENNYWORTH");
  if (hooksDir) await git(path, "config", "core.hooksPath", hooksDir);
  await git(path, "fetch", "--quiet", "--prune", "origin");
  await git(path, "remote", "set-head", "origin", "--auto").catch(() => {});
  const base = await defaultBranch(path);
  if (await hasRef(path, `origin/${base}`)) await git(path, "checkout", "--quiet", "-B", base, `origin/${base}`);
  else await git(path, "symbolic-ref", "HEAD", `refs/heads/${base}`); // empty repository
  for (const b of (await git(path, "for-each-ref", "--format=%(refname:short)", "refs/heads")).split("\n").filter(Boolean)) {
    if (b !== base) await git(path, "branch", "-D", b); // only what the task makes
  }
  return path;
}

/** The agent's optional note on its branches: [{ repo, branch, base, purpose }]. */
export function readManifest(workspace) {
  try {
    const list = JSON.parse(readFileSync(join(workspace, MANIFEST), "utf8"));
    return Array.isArray(list) ? list.filter((e) => e && typeof e.branch === "string") : [];
  } catch {
    return [];
  }
}

/** The pushed tip of a branch per the last fetch, or "". */
const remoteTip = (path, branch) => git(path, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`).catch(() => "");

const count = async (path, tip, not) => Number(await git(path, "rev-list", "--count", tip, "--not", not).catch(() => "1000000"));

/**
 * The task's branches in one clone, each with its base: the branch it was made from. That's the
 * closest of the task's other branches it is stacked on and the branches on GitHub (the default one,
 * or another long-lived one such as `v2`): the one leaving the fewest commits of its own. The agent's
 * manifest wins when it names one of those. A local branch with no commits beyond its base (the
 * default branch, a plain checkout of `v2`) isn't a task branch.
 */
export async function findBranches(path, { base, manifest = [], slug, known = [] }) {
  const onBase = await hasRef(path, `origin/${base}`);
  const heads = (await git(path, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads")).split("\n").filter(Boolean).map((l) => l.split(" "));
  // Branches on GitHub that could be a base: the default one first, then the most recently updated.
  const remotes = (await git(path, "for-each-ref", "--sort=-committerdate", "--count=60", "--format=%(refname:lstrip=3)", "refs/remotes/origin")).split("\n").filter((r) => r && r !== "HEAD");
  const bases = [...new Set([...(onBase ? [base] : []), ...remotes])];
  const found = [];
  for (const [branch, tip] of heads) {
    if (branch === base) continue;
    // A checkout of a branch on GitHub with nothing new (a local `v2`) is only the task's if the task
    // made it (pushed, maybe with a PR).
    if (!known.includes(branch) && (await hasRef(path, `origin/${branch}`)) && !(await count(path, tip, `origin/${branch}`))) continue;
    let best;
    for (const r of bases) {
      if (r === branch) continue; // its own pushed copy is not its base
      const n = await count(path, tip, `origin/${r}`);
      if (!best || n < best.n) best = { base: r, n };
    }
    const own = best ? best.n : Number(await git(path, "rev-list", "--count", tip));
    if (own) found.push({ branch, tip, own, remoteBase: best?.base ?? base, counts: new Map([[best?.base ?? base, own]]) });
  }
  // A repository that is still empty on GitHub: its default branch is published as the first commits.
  const baseTip = heads.find(([b]) => b === base)?.[1];
  if (!onBase && baseTip) found.unshift({ branch: base, tip: baseTip, own: Number(await git(path, "rev-list", "--count", baseTip)), remoteBase: base, counts: new Map() });
  for (const b of found) {
    const named = manifest.find((m) => m.branch === b.branch && (!m.repo || !slug || String(m.repo).toLowerCase() === slug.toLowerCase()));
    let pick = { base: b.remoteBase, n: b.own };
    for (const o of found) {
      if (o.branch === b.branch || o.tip === b.tip || o.branch === base) continue;
      if (!(await git(path, "merge-base", "--is-ancestor", o.tip, b.tip).then(() => true, () => false))) continue;
      const n = await count(path, b.tip, o.tip);
      b.counts.set(o.branch, n);
      if (n < pick.n) pick = { base: o.branch, n };
    }
    // The manifest's base, if it is one of the candidates and as close as the best one.
    if (named?.base && named.base !== b.branch && (bases.includes(named.base) || found.some((o) => o.branch === named.base))) {
      const n = b.counts.get(named.base) ?? (found.some((o) => o.branch === named.base) ? await count(path, b.tip, named.base) : await count(path, b.tip, `origin/${named.base}`));
      if (n <= pick.n) pick = { base: named.base, n };
    }
    b.base = pick.base;
    b.purpose = typeof named?.purpose === "string" ? named.purpose.slice(0, 300) : "";
  }
  return found.map(({ branch, base: b, purpose, tip }) => ({ branch, base: b, purpose, tip }));
}

/**
 * What a branch's base is in git: the task branch of that name when there is one (stacked), else the
 * branch on GitHub (`origin/<base>`), else nothing (an empty repository).
 */
export async function baseRef(path, { branch, base, taskBranches = [] }) {
  if (base !== branch && taskBranches.includes(base) && (await hasRef(path, `refs/heads/${base}`))) return base;
  return (await hasRef(path, `origin/${base}`)) ? `origin/${base}` : "";
}

/** Commits on `branch` that aren't on GitHub yet (oldest first), and the diffstat against its base. */
export async function branchChanges(path, { branch, base, taskBranches = [] }) {
  const from = (await baseRef(path, { branch, base, taskBranches })) || EMPTY_TREE;
  const stop = from === EMPTY_TREE ? [] : [from];
  const unpublished = (await git(path, "log", "--reverse", "--format=%h %s", branch, "--not", "--remotes=origin", ...stop)).split("\n").filter(Boolean);
  const stat = await git(path, "diff", "--shortstat", from === EMPTY_TREE ? EMPTY_TREE : `${from}...${branch}`, ...(from === EMPTY_TREE ? [branch] : [])).catch(() => "");
  const tip = await git(path, "rev-parse", branch);
  const pushed = await remoteTip(path, branch);
  return { unpublished, stat, upToDate: pushed === tip, onGitHub: Boolean(pushed) };
}

/** Full messages of the commits on `branch` since `from` (oldest first), for PR descriptions and checks. */
export async function messagesSince(path, from, branch) {
  return (await git(path, "log", "--reverse", "--format=%B%x1e", from ? `${from}..${branch}` : branch).catch(() => "")).split("\x1e").map((m) => m.trim()).filter(Boolean);
}

/** Worktrees of a clone (the clone itself first): [{ path, branch (or ""), head }]. */
export async function worktrees(path) {
  const out = [];
  let cur;
  for (const line of (await git(path, "worktree", "list", "--porcelain")).split("\n")) {
    if (line.startsWith("worktree ")) out.push((cur = { path: line.slice(9), branch: "", head: "" }));
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  return out.filter((w) => existsSync(w.path));
}

/**
 * Sign the commits the agent made (it has no SSH agent, so it commits unsigned), keeping their trees,
 * messages, authors and dates. Only commits GitHub doesn't have are touched, oldest first; their
 * descendants follow, and every local branch is moved to the rewritten tip. Worktrees on those
 * branches stay clean: the trees are identical. Returns the number of commits rewritten.
 */
export async function signUnsigned(path) {
  if ((await git(path, "config", "--bool", "--get", "commit.gpgsign").catch(() => "")) !== "true") return 0;
  const list = (await git(path, "rev-list", "--reverse", "--topo-order", "--parents", "--branches", "--not", "--remotes=origin")).split("\n").filter(Boolean).map((l) => l.split(" "));
  const map = new Map();
  const dir = mkdtempSync(join(tmpdir(), "pw-sign-"));
  try {
    for (const [sha, ...parents] of list) {
      const raw = await git(path, "cat-file", "commit", sha);
      const header = raw.split("\n\n")[0];
      if (/^gpgsig /m.test(header) && !parents.some((p) => map.has(p))) continue;
      const person = (role) => {
        const m = new RegExp(`^${role} (.*) <([^>]*)> (\\d+ [+-]\\d{4})$`, "m").exec(header);
        return m ? { name: m[1], email: m[2], date: m[3] } : undefined;
      };
      const author = person("author");
      const committer = person("committer");
      const msgFile = join(dir, "msg");
      writeFileSync(msgFile, raw.slice(raw.indexOf("\n\n") + 2));
      const tree = /^tree (\w+)$/m.exec(header)[1];
      const args = ["commit-tree", "-S", tree, ...parents.flatMap((p) => ["-p", map.get(p) ?? p]), "-F", msgFile];
      const env = {
        GIT_AUTHOR_NAME: author?.name, GIT_AUTHOR_EMAIL: author?.email, GIT_AUTHOR_DATE: author?.date,
        GIT_COMMITTER_NAME: committer?.name, GIT_COMMITTER_EMAIL: committer?.email, GIT_COMMITTER_DATE: committer?.date,
      };
      map.set(sha, await gitEnv(path, env, ...args));
    }
    if (!map.size) return 0;
    for (const line of (await git(path, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads")).split("\n").filter(Boolean)) {
      const [ref, tip] = line.split(" ");
      if (map.has(tip)) await git(path, "update-ref", ref, map.get(tip), tip);
    }
    // Worktrees on a detached HEAD at a rewritten commit follow too.
    for (const w of await worktrees(path)) if (!w.branch && map.has(w.head)) await git(w.path, "update-ref", "--no-deref", "HEAD", map.get(w.head), w.head);
    return map.size;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gitEnv(cwd, env, ...args) {
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v));
  return new Promise((resolve, reject) =>
    execFile("git", args, { cwd, env: { ...process.env, ...clean, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout.trim()))),
  );
}

/**
 * Commits made on the default branch itself move to a new branch (`name`), and the default branch goes
 * back to GitHub's: nothing is ever published as the default branch by accident. Returns the new
 * branch, or "" when the default branch has nothing of its own.
 */
export async function moveOffDefault(path, base, name) {
  if (!(await hasRef(path, `origin/${base}`)) || !(await hasRef(path, `refs/heads/${base}`))) return "";
  if (!Number(await git(path, "rev-list", "--count", base, "--not", `origin/${base}`))) return "";
  await git(path, "branch", name, base);
  for (const w of await worktrees(path)) if (w.branch === base) await git(w.path, "switch", "--quiet", name); // same commit: changes stay
  await git(path, "branch", "-f", base, `origin/${base}`);
  return name;
}

/** Carry the commits after `since` on `branch` onto a new branch `name` from origin/<base> (a merged PR's follow-ups). */
export async function carryOver(path, { branch, base, since, name }) {
  const range = (await hasRef(path, `${since}^{commit}`)) ? `${since}..${branch}` : `origin/${base}..${branch}`;
  const carry = (await git(path, "rev-list", "--reverse", "--no-merges", range)).split("\n").filter(Boolean);
  if (!carry.length) return 0;
  const tmp = mkdtempSync(join(tmpdir(), "pw-carry-"));
  try {
    await git(path, "worktree", "add", "--quiet", "-b", name, join(tmp, "w"), `origin/${base}`);
    try {
      for (const sha of carry) await git(join(tmp, "w"), "-c", "core.hooksPath=/dev/null", "cherry-pick", "--allow-empty", sha);
    } catch (err) {
      await git(join(tmp, "w"), "cherry-pick", "--abort").catch(() => {});
      await git(path, "worktree", "remove", "--force", join(tmp, "w"));
      await git(path, "branch", "-D", name);
      throw err;
    }
    await git(path, "worktree", "remove", "--force", join(tmp, "w"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await git(path, "worktree", "prune").catch(() => {});
  }
  // Wherever the old branch is checked out cleanly, continue on the new one.
  for (const w of await worktrees(path)) if (w.branch === branch && !(await git(w.path, "status", "--porcelain"))) await git(w.path, "switch", "--quiet", name);
  return carry.length;
}

/** Every worktree of every clone with uncommitted changes: [{ repo, path, branch }]. */
export async function dirtyCheckouts(repos) {
  const out = [];
  for (const r of repos) for (const w of await worktrees(r.path)) if (await git(w.path, "status", "--porcelain").catch(() => "")) out.push({ repo: r, path: w.path, branch: w.branch });
  return out;
}

/** Copy every local branch of a clone into the cache as refs/kept/<task>/… before a workspace is removed. */
export async function keepBranches(path, cache, identifier) {
  await git(cache, "fetch", "--quiet", path, `+refs/heads/*:refs/kept/${identifier}/*`).catch(() => {});
}

