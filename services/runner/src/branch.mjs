// Branch names on GitHub follow the repository's own conventions. Task worktrees start on a local
// branch (pennyworth/<task>); on the first push it is renamed to a name in the repository's style,
// because the repos we push to have nothing to do with Pennyworth. A short Codex call picks the name
// from the contributing guide and recent branch names; code checks it and falls back to <type>/<slug>.
import { askCodex } from "./intake.mjs";
import { leaksInternal } from "./describe.mjs";

export const BRANCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["branch"],
  properties: { branch: { type: "string" } },
};

/** Local task branches: never pushed under this name. */
export const isLocalBranch = (branch) => /^pennyworth\//.test(String(branch ?? ""));

/** Lines about branches from contributing guides and agent instructions in the repository. */
export function branchGuidance(files) {
  const out = [];
  for (const [name, text] of files) {
    const lines = String(text ?? "").split("\n");
    const keep = new Set();
    lines.forEach((l, i) => {
      if (/\bbranch(es)?\b/i.test(l) && !/\bbranch protection\b/i.test(l)) for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j);
    });
    if (keep.size) out.push(`${name}:\n${[...keep].sort((a, b) => a - b).map((i) => lines[i]).join("\n")}`);
  }
  return out.join("\n\n").slice(0, 3000);
}

/** Recent PR branches by people (no bots, none of ours), the user's own first. */
export function exampleBranches(prs, { login, base }) {
  const seen = new Set();
  const mine = [];
  const others = [];
  for (const pr of prs ?? []) {
    const name = String(pr?.headRefName ?? "");
    const author = String(pr?.author?.login ?? "");
    if (!name || seen.has(name) || name === base || isLocalBranch(name) || pr?.author?.is_bot || /^app\/|\[bot\]$/.test(author) || /^(dependabot|renovate|release-please)/.test(name)) continue;
    seen.add(name);
    (login && author.toLowerCase() === login.toLowerCase() ? mine : others).push(name);
  }
  return { mine: mine.slice(0, 15), others: others.slice(0, 30) };
}

export function branchPrompt({ repo, login, guidance, examples, request, messages }) {
  const fence = (label, text, max) => `<<<${label}\n${String(text ?? "").replace(/<<<|>>>/g, "‹‹‹").slice(0, max)}\n${label}>>>`;
  return `Name the git branch for a change to ${repo}, following that repository's conventions. Answer with JSON. Do not run any tools.

Rules:
- Follow the branch naming rules in the contributing guide below, if there are any.
- Otherwise follow the pattern of ${login ? `${login}'s own recent branches (the user, who opens this PR), then of ` : ""}the repository's recent branches: the same prefix style (for example "feat/…", "fix/…", "<username>/…"${login ? `, with the username ${login}` : ""}), separators and casing.
- If there is no clear pattern, use "<type>/<short-description>" with a conventional commit type (feat, fix, chore, docs, refactor, test, ci).
- The description part says what the change does in a few kebab-case words. At most 60 characters in total.
- Never mention a task tracker, ticket number, agent, AI tool, or this machine.

${fence("CONTRIBUTING", guidance || "(none found)", 3000)}

${fence(login ? `RECENT_BRANCHES_BY_${login}` : "RECENT_BRANCHES_BY_USER", examples.mine.join("\n") || "(none)", 1500)}

${fence("RECENT_BRANCHES_BY_OTHERS", examples.others.join("\n") || "(none)", 2000)}

${fence("COMMITS", messages.join("\n\n---\n\n"), 3000)}

${fence("REQUEST", request, 4000)}`;
}

/** A usable branch name, or "" when it isn't one we would push. */
export function checkBranchName(raw, { base, defaultBranch }) {
  const name = String(raw ?? "").trim().replace(/^refs\/heads\//, "");
  if (!name || name.length > 80) return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(name) || /\/\/|\.\.|\.lock(\/|$)|[./]$|\/\./.test(name)) return "";
  if (leaksInternal(name) || isLocalBranch(name)) return "";
  if ([base, defaultBranch, "main", "master", "develop", "HEAD"].includes(name)) return "";
  return name;
}

/** `feat: add X` → `feat/add-x`; anything else → `chore/<slug>`. */
export function fallbackBranchName(subject) {
  const m = String(subject ?? "").match(/^(\w+)(?:\([^)]*\))?!?:\s*(.*)$/);
  const type = m && /^(feat|fix|chore|docs|refactor|test|ci|build|perf|style)$/i.test(m[1]) ? m[1].toLowerCase() : "chore";
  const slug = String(m ? m[2] : subject ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  const name = `${type}/${slug || "update"}`;
  return leaksInternal(name) ? `${type}/update` : name;
}

/**
 * The branch name to publish under. `taken(name)` says whether a name is already in use (locally or
 * on GitHub); a taken name gets -2, -3, … appended. `ask` answers the prompt (a Codex call by default).
 */
export async function chooseBranchName({ cfg, repo, base, defaultBranch, login, guidance, prs, request, messages, taken, ask = (prompt) => askCodex(cfg, prompt, BRANCH_SCHEMA) }) {
  const subject = messages.at(-1)?.split("\n")[0] ?? "";
  let name = "";
  let generated = false;
  try {
    const examples = exampleBranches(prs, { login, base });
    const raw = await ask(branchPrompt({ repo, login, guidance, examples, request, messages }));
    name = checkBranchName(raw?.branch, { base, defaultBranch });
    generated = Boolean(name);
  } catch {
    /* fall back below */
  }
  if (!name) name = checkBranchName(fallbackBranchName(subject), { base, defaultBranch }) || "chore/update";
  let free = name;
  for (let n = 2; await taken(free); n++) free = `${name}-${n}`;
  return { name: free, generated };
}
