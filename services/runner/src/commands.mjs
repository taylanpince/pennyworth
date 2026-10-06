// Parsing of the user's Paperclip comments into runner commands and job settings.
// Pure functions (unit-tested): no I/O here.

export const RUNNER_MARKER = "<!-- pennyworth-runner -->";

const COMMANDS = new Map([
  ["stop", "stop"],
  ["cancel", "stop"],
  ["push", "push"],
  ["pr", "pr"],
  ["draft pr", "pr"],
  ["open pr", "pr"],
  ["reset", "reset"],
  ["status", "status"],
  ["cleanup", "cleanup"],
]);

const DIRECTIVE = /^\s*(repo|mode|engine|model|shells?|base)\s*:\s*(.+?)\s*$/i;

/** Remove HTML comments so hidden text can never carry directives. */
const stripHidden = (s) => s.replace(/<!--[\s\S]*?-->/g, "");

/**
 * Split a comment into a single-word command, `key: value` directives and free-form
 * instructions. Directives may appear on any line; everything else is instructions.
 */
export function parseComment(body) {
  const text = stripHidden(String(body ?? "")).trim();
  const command = COMMANDS.get(text.toLowerCase().replace(/[.!]+$/, ""));
  if (command) return { command, directives: {}, instructions: "" };
  const directives = {};
  const rest = [];
  for (const line of text.split(/\r?\n/)) {
    const m = DIRECTIVE.exec(line);
    if (m) directives[m[1].toLowerCase().replace(/^shell$/, "shells")] = m[2];
    else rest.push(line);
  }
  return { command: undefined, directives, instructions: rest.join("\n").trim() };
}

/** Normalize "org/repo", "https://github.com/org/repo(.git)" or "git@github.com:org/repo.git". */
export function normalizeRepo(value) {
  const m = /(?:github\.com[/:])?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(String(value ?? "").trim());
  if (!m) return undefined;
  return { org: m[1], name: m[2], slug: `${m[1]}/${m[2]}` };
}

export function repoAllowed(repo, allowedOrgs) {
  return Boolean(repo) && allowedOrgs.some((o) => o.toLowerCase() === repo.org.toLowerCase());
}

/** Find allowlisted repositories mentioned in free text (URLs or org/repo tokens). */
export function findRepos(text, allowedOrgs) {
  const found = new Map();
  const re = /(?:https?:\/\/github\.com\/|git@github\.com:|\b)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[\s/#?)\]>,.;:'"`]|$)/g;
  for (const m of String(text ?? "").matchAll(re)) {
    const repo = { org: m[1], name: m[2], slug: `${m[1]}/${m[2]}` };
    if (repoAllowed(repo, allowedOrgs)) found.set(repo.slug.toLowerCase(), repo);
  }
  return [...found.values()];
}

/**
 * Resolve the engine for a job: `engine: codex` (default), `engine: claude` (Claude Code),
 * `engine: glm` / `openrouter` (configured default OpenRouter model), `engine: openrouter:<model>`,
 * or a bare OpenRouter model id like `z-ai/glm-5.3`. A Claude model name alone (`model: opus`)
 * picks Claude Code.
 */
export function resolveEngine(directives, cfg, previous) {
  const raw = (directives.engine ?? "").trim().toLowerCase();
  const model = directives.model?.trim();
  if (!raw && !model) return previous ?? { kind: "codex", model: cfg.engines.codex.model || undefined };
  if (raw === "codex") return { kind: "codex", model: model || cfg.engines.codex.model || undefined };
  if (["claude", "claude-code", "claude code", "anthropic"].includes(raw)) return { kind: "claude", model: model || cfg.engines.claude?.model || undefined };
  if (raw === "glm" || raw === "openrouter" || raw === "opencode") return { kind: "openrouter", model: model || cfg.engines.openrouter.model };
  if (raw.startsWith("openrouter:")) return { kind: "openrouter", model: directives.engine.trim().slice("openrouter:".length) };
  if (raw.includes("/")) return { kind: "openrouter", model: directives.engine.trim() };
  if (!raw && isClaudeModel(model)) return { kind: "claude", model };
  if (!raw && model) return { kind: previous?.kind === "claude" ? "codex" : previous?.kind ?? "codex", model };
  throw new Error(`unknown engine "${directives.engine}" (use codex, claude, glm, or openrouter:<model>)`);
}

/** Claude Code model names: the aliases (opus, sonnet, haiku, fable) or a full `claude-…` id. */
export function isClaudeModel(model) {
  return /^(opus|sonnet|haiku|fable|claude-[a-z0-9.-]+)(\[1m\])?$/i.test(String(model ?? "").trim());
}

export function resolveMode(directives, previous) {
  const m = (directives.mode ?? "").trim().toLowerCase();
  if (!m) return previous ?? "investigate";
  if (["investigate", "investigation", "report", "read"].includes(m)) return "investigate";
  if (["implement", "implementation", "fix", "change", "write"].includes(m)) return "implement";
  throw new Error(`unknown mode "${directives.mode}" (use investigate or implement)`);
}

/** Devshells: explicit `shells:` wins; otherwise detected from repo files and the request. */
export function resolveShells(directives, detected, instructions, cfg) {
  const available = new Set(cfg.devshells.available);
  let shells;
  if (directives.shells) {
    shells = directives.shells.split(/[\s,]+/).filter(Boolean);
  } else {
    shells = [...detected];
    for (const [pattern, shell] of Object.entries(cfg.devshells.keyword_shells ?? {})) {
      if (new RegExp(pattern, "i").test(instructions) && !shells.includes(shell)) shells.push(shell);
    }
  }
  const bad = shells.filter((s) => !available.has(s));
  if (bad.length) throw new Error(`unknown devshell(s): ${bad.join(", ")} (available: ${[...available].join(", ")})`);
  // The engine shell (with codex/opencode) is always outermost.
  return [cfg.devshells.engine_shell, ...shells.filter((s) => s !== cfg.devshells.engine_shell)];
}

/**
 * The request in a task's description, when the user wrote the task themselves: created with
 * their own key, by no agent, and without the source marker that Pennyworth's generated tasks
 * carry. Descriptions of generated tasks hold Slack/email text and stay untrusted context.
 */
export function ownRequest(issue) {
  const text = String(issue?.description ?? "");
  if (!issue?.createdByUserId || issue.createdByAgentId || /<!--\s*source:/.test(text)) return "";
  return stripHidden(text).trim();
}

export const branchFor = (identifier) => `pennyworth/${identifier.toLowerCase()}`;
