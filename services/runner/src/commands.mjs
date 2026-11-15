// The exact push/pr commands, repository names, engines, modes and devshells.
// Pure functions (unit-tested): no I/O here.

export const RUNNER_MARKER = "<!-- pennyworth-runner -->";

/** The board's marks (D-54): a message on the user's task for other agents only, and where a delivered one came from. */
export const FOR_OTHERS = "<!-- pennyworth-for-others -->";

/** The chat a message delivered from another one came from (D-54): the task's identifier. */
export function deliveredFrom(body) {
  return /<!-- pennyworth-from:([A-Z][A-Z0-9]*-\d+)(?::[0-9a-f-]{36})? -->/.exec(String(body ?? ""))?.[1];
}

// Publishing to GitHub is the one irreversible action, so it takes the exact word. Everything
// else in a comment, including stop/status/reset/cleanup, is read by the intake (intake.mjs).
const COMMANDS = new Map([
  ["push", "push"],
  ["pr", "pr"],
  ["draft pr", "pr"],
  ["open pr", "pr"],
]);

/** Remove HTML comments: hidden text never counts as the user's words. */
export const stripHidden = (s) => String(s ?? "").replace(/<!--[\s\S]*?-->/g, "");

/** "push" or "pr" when the whole comment is exactly that word; otherwise undefined. */
export function parseCommand(body) {
  return COMMANDS.get(stripHidden(body).trim().toLowerCase().replace(/[.!]+$/, ""));
}

/**
 * Normalize "org/repo", "https://github.com/org/repo(.git)", "git@github.com:org/repo.git", or any
 * of these as Paperclip stores them: Markdown links ("[url](url)"), "<url>", backslash escapes.
 */
export function normalizeRepo(value) {
  const text = String(value ?? "")
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, "$2") // [text](url) → url
    .replace(/\\(.)/g, "$1") // \_ → _
    .replace(/[<>`]/g, " ")
    .trim();
  const m =
    /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[/#?\s)]|$)/.exec(text) ??
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[/#?\s]|$)/.exec(text);
  if (!m) return undefined;
  return { org: m[1], name: m[2], slug: `${m[1]}/${m[2]}` };
}

export function repoAllowed(repo, allowedOrgs) {
  return Boolean(repo) && allowedOrgs.some((o) => o.toLowerCase() === repo.org.toLowerCase());
}

/** Find allowlisted repositories mentioned in free text (URLs or org/repo tokens). */
export function findRepos(text, allowedOrgs) {
  return mentionedRepos(text).filter((r) => repoAllowed(r, allowedOrgs));
}

/**
 * Every org/repo token in free text, in any org. Many aren't repositories at all ("DA/L1"), so
 * ones outside the allowed orgs only count once GitHub confirms them as public (`publicRepo`).
 */
export function mentionedRepos(text) {
  const found = new Map();
  // Dots belong to names (0xsequence/sequence.js); one only ends a name at the end of a sentence
  // ("see org/repo."). A match never starts inside another token (".js/pull" in a URL).
  const re = /(?:https?:\/\/github\.com\/|git@github\.com:|(?<![\w.\/@:-]))([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[\s/#?)\]>,;:'"`]|\.(?:[\s)\]>,;:'"`]|$)|$)/g;
  for (const m of String(text ?? "").matchAll(re)) {
    if (/^\.+$/.test(m[1]) || /^\.+$/.test(m[2])) continue;
    const repo = { org: m[1], name: m[2], slug: `${m[1]}/${m[2]}` };
    if (!found.has(repo.slug.toLowerCase())) found.set(repo.slug.toLowerCase(), repo);
  }
  return [...found.values()];
}

/**
 * Repositories outside the allowed orgs are read-only (D-35): answer and investigate work there,
 * implement, push and pr don't. Returns why a request can't go ahead, or undefined.
 */
export function readOnlyRefusal(slug, allowedOrgs, what) {
  const repo = normalizeRepo(slug);
  if (!repo || repoAllowed(repo, allowedOrgs)) return undefined;
  return `\`${repo.slug}\` is outside your orgs (${allowedOrgs.join(", ")}), so I only read it: I can investigate or answer questions there, but not ${what}. To change it, add \`${repo.org}\` to \`allowed_orgs\` in \`config/runner.yaml\`.`;
}

/**
 * Resolve the engine for a job: `engine: codex` (default), `engine: claude` (Claude Code),
 * `engine: openrouter` / `glm` (configured default OpenRouter model), `engine: openrouter:<model>`,
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
  throw new Error(`unknown engine "${directives.engine}" (use codex, claude, openrouter, or openrouter:<model>)`);
}

// The crew's runner roles (D-20, D-60): the role is the assignee, the engine a setting. A role runs on
// its own engine and model (agent metadata `role`) unless the task's executor override names another
// (`adapterConfig.engine`, then `model` and effort). Agents from before roles have no `role`: their
// Paperclip adapter is the engine and their primary model the model.
const ADAPTER_ENGINE = { codex_local: "codex", claude_local: "claude", opencode_local: "openrouter" };
const KINDS = ["codex", "claude", "openrouter"];
const EFFORT_KEY = { codex: "modelReasoningEffort", claude: "effort" }; // where Paperclip's picker stores it
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/** One of the runner's crew roles (an Engineer): set up as one by setup, or an Engineer from before roles. */
export function isRole(agent) {
  return agent?.metadata?.runnerEngine === true || /^pennyworth:engineer(-|$)/.test(agent?.metadata?.setupKey ?? "");
}

/** A role's own engine, model and effort (D-60), before any override on a task. */
export function roleEngine(agent) {
  const role = agent?.metadata?.role;
  if (role && KINDS.includes(role.engine)) {
    return { kind: role.engine, model: typeof role.model === "string" ? role.model : "", ...(EFFORTS.has(role.effort) ? { effort: role.effort } : {}) };
  }
  const kind = ADAPTER_ENGINE[agent?.adapterType];
  return kind ? { kind, model: typeof agent.adapterConfig?.model === "string" ? agent.adapterConfig.model : "" } : undefined;
}

/**
 * The executor picked on the task in Paperclip: its role's engine unless the override names another;
 * the override's model, else the role's (on its own engine), else config/runner.yaml's. Undefined when
 * the task isn't assigned to a role.
 */
export function pickedEngine(issue, engineers, cfg) {
  const agent = engineers.find((a) => a.id === issue?.assigneeAgentId);
  const own = roleEngine(agent);
  if (!own) return undefined;
  const override = issue.assigneeAdapterOverrides?.adapterConfig ?? {};
  const kind = KINDS.includes(override.engine) ? override.engine : own.kind;
  // opencode ids are provider/model; only OpenRouter models are runnable here.
  const usable = (m) => {
    const v = typeof m === "string" ? m.trim() : "";
    if (kind !== "openrouter") return v;
    return v.startsWith("openrouter/") ? v.slice("openrouter/".length) : "";
  };
  const fallback = kind === "codex" ? cfg.engines.codex.model : kind === "claude" ? cfg.engines.claude?.model : cfg.engines.openrouter.model;
  const model = usable(override.model) || (kind === own.kind ? usable(own.model) : "") || fallback || undefined;
  const key = EFFORT_KEY[kind];
  const effort = key ? String(override[key] ?? (kind === own.kind ? own.effort ?? "" : "")).trim().toLowerCase() : "";
  return { kind, model, ...(EFFORTS.has(effort) ? { effort } : {}) };
}

/**
 * The Paperclip fields that show `engine` as the task's picker: the role (the task's own, else the first
 * whose engine it is) as assignee, and an override for whatever differs from that role's own engine,
 * model and effort. Undefined if no role can run it.
 */
export function pickerFor(engine, engineers, agentId) {
  const agent = engineers.find((a) => a.id === agentId && isRole(a)) ?? engineers.find((a) => roleEngine(a)?.kind === engine.kind) ?? engineers.find(isRole);
  const own = roleEngine(agent);
  if (!own) return undefined;
  const model = engine.model && engine.kind === "openrouter" ? `openrouter/${engine.model}` : engine.model;
  const config = {
    ...(engine.kind !== own.kind ? { engine: engine.kind } : {}),
    ...(model && (engine.kind !== own.kind || model !== own.model) ? { model } : {}),
    ...(engine.effort && EFFORT_KEY[engine.kind] && (engine.kind !== own.kind || engine.effort !== own.effort) ? { [EFFORT_KEY[engine.kind]]: engine.effort } : {}),
  };
  return { assigneeAgentId: agent.id, assigneeAdapterOverrides: Object.keys(config).length ? { adapterConfig: config } : null };
}

/** OpenRouter models offered in the picker (setup's engine catalog, D-60; before it, the OpenRouter Engineer's list). */
export function openrouterModels(engineers) {
  const ids = engineers.flatMap((a) => [
    ...(Array.isArray(a.metadata?.engines?.openrouter) ? a.metadata.engines.openrouter : []),
    ...(a.adapterType === "opencode_local" && !a.metadata?.role ? [a.adapterConfig?.model, ...(Array.isArray(a.metadata?.models) ? a.metadata.models : [])] : []),
  ]);
  return [...new Set(ids.filter((m) => typeof m === "string" && m.startsWith("openrouter/")).map((m) => m.slice("openrouter/".length)))];
}

/** A crew member's board identity (D-45) and role (D-60): name, voice and the job in one line. */
export function personaFor(agent) {
  const p = agent?.metadata?.persona;
  if (typeof p?.name !== "string" || !p.name) return undefined;
  const job = agent.metadata?.role?.job;
  return { name: p.name, voice: typeof p.voice === "string" ? p.voice : "", ...(typeof job === "string" && job ? { role: job } : {}) };
}

/** The crew's names and what each takes on, for the prompt: the runner roles and the woken agents with a persona. */
export function crewNames(agents) {
  return agents.flatMap((a) => {
    const p = personaFor(a);
    return p ? [{ name: p.name, role: p.role ?? "", engine: isRole(a) ? roleEngine(a)?.kind : undefined }] : [];
  });
}

/** Claude Code model names: the aliases (opus, sonnet, haiku, fable) or a full `claude-…` id. */
export function isClaudeModel(model) {
  return /^(opus|sonnet|haiku|fable|claude-[a-z0-9.-]+)(\[1m\])?$/i.test(String(model ?? "").trim());
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

/**
 * A sub-task an agent (the Assistant) created for an Engineer under one of the user's tasks. Its
 * description is agent-written, so it waits for the user's go-ahead (D-24) before it is the request.
 */
/** A part of the user's task they gave an Engineer themselves (D-45): their own request, no go-ahead needed. */
export function isUserPart(issue, engineers) {
  return Boolean(issue?.parentId && issue.createdByUserId && !issue.createdByAgentId && engineers.some((e) => e.id === issue.assigneeAgentId));
}

export function isAgentSubtask(issue) {
  return Boolean(issue?.parentId && issue.createdByAgentId && !issue.createdByUserId);
}
