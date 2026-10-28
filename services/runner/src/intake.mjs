// Short no-tools Codex calls with a JSON schema for their answer (askCodex), used by the runner's
// small readings: the go-ahead on sub-tasks (D-24), the check on an Engineer's GitHub writes
// (authorize.mjs) and comments that arrive while a task is busy (busy.mjs). Also the model names a
// request can use. The runner no longer reads requests for the agent: every comment goes to the
// Engineer (docs/design/conversational-engineers.md).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { inDevshells } from "./engines.mjs";

/** Codex model slugs known to the local Codex install (newest first, as Codex lists them). */
export function codexModels(file = join(homedir(), ".codex/models_cache.json")) {
  try {
    return JSON.parse(readFileSync(file, "utf8")).models.map((m) => m.slug).filter(Boolean);
  } catch {
    return [];
  }
}

/** "astra" → "gpt-6-astra": an exact slug, or the first model whose name contains the word. */
export function resolveModelAlias(name, models) {
  const n = String(name ?? "").trim().toLowerCase();
  if (!n) return undefined;
  const exact = models.find((m) => m.toLowerCase() === n);
  if (exact) return exact;
  return models.find((m) => m.toLowerCase().split(/[-_.\s]+/).includes(n) || m.toLowerCase().endsWith(`-${n}`));
}

/**
 * "deepseek" → "deepseek/deepseek-v4.1-flash", "glm5.3-flash" → "z-ai/glm-5.3-flash": a known OpenRouter
 * model by id, by name, or by a word in it (first in the list wins); a full provider/model id is kept as is.
 */
export function resolveOpenRouterModel(name, models) {
  const n = String(name ?? "").trim().toLowerCase().replace(/^openrouter\//, "");
  if (!n) return undefined;
  const flat = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const known =
    models.find((m) => m.toLowerCase() === n) ??
    models.find((m) => flat(m.split("/").pop()) === flat(n)) ??
    models.find((m) => flat(m).includes(flat(n)));
  if (known) return known;
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/.test(n) ? n : undefined;
}

/** A task's description, followed by the user's task it is part of (D-45), whose text the request builds on. */
export function withParent(description, parent) {
  const own = String(description ?? "").trim();
  if (!parent) return own;
  return [own, `The task this is part of (${parent.identifier}): ${parent.title}`, String(parent.description ?? "").trim()].filter(Boolean).join("\n\n");
}

/** One no-tools Codex call with a JSON schema for its answer; resolves with the parsed JSON. */
export async function askCodex(cfg, prompt, schema) {
  const dir = mkdtempSync(join(tmpdir(), "pennyworth-intake-"));
  try {
    writeFileSync(join(dir, "schema.json"), JSON.stringify(schema));
    const out = join(dir, "out.json");
    const model = cfg.intake?.model;
    const argv = inDevshells(cfg.devshells.flake, [cfg.devshells.engine_shell], [
      "codex", "exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only",
      "-c", `model_reasoning_effort="${cfg.intake?.reasoning_effort ?? "low"}"`,
      "--output-schema", join(dir, "schema.json"), "-o", out,
      ...(model ? ["-m", model] : []),
      "-",
    ]);
    const env = { ...process.env };
    delete env.SSH_AUTH_SOCK;
    await new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: dir, env, stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
      const timer = setTimeout(() => child.kill("SIGKILL"), (cfg.intake?.timeout_seconds ?? 180) * 1000);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        code === 0 && existsSync(out) ? resolve() : reject(new Error(`intake exited with ${code}: ${err.trim().split("\n").pop() ?? ""}`));
      });
      child.stdin.end(prompt);
    });
    return JSON.parse(readFileSync(out, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ go-ahead for sub-tasks

export const APPROVAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision"],
  properties: { decision: { type: "string", enum: ["start", "hold", "other"] } },
};

export function approvalPrompt({ user, title, waiting, comment }) {
  return `${user} asked the Assistant to split the task "${title}" into Engineer tasks. These are created and waiting for ${user}'s go-ahead before any of them starts:

${waiting.map((w) => `- ${w.identifier}: ${String(w.title).replace(/[\r\n]+/g, " ").slice(0, 160)}`).join("\n")}

Read ${user}'s newest comment on that task and answer with JSON:
- "start": a clear go-ahead to start ALL of the waiting tasks as they are ("go", "go ahead", "start them", "looks good, run them", "👍").
- "hold": explicitly not yet ("wait", "don't start yet", "hold off").
- "other": anything else, including a go-ahead with changes or exceptions ("go, but skip X", "use opus instead", "add repo Y first"), questions and edits. Those go to the Assistant.
When in doubt, "other". Do not run any tools.

<<<COMMENT
${String(comment).replace(/<<<|>>>/g, "‹‹‹").slice(0, 4000)}
COMMENT>>>`;
}

/** Is the newest comment on a parent task the go-ahead for its waiting sub-tasks? Rejects on failure. */
export async function readApproval({ cfg, user, title, waiting, comment }) {
  const raw = await askCodex(cfg, approvalPrompt({ user, title, waiting, comment }), APPROVAL_SCHEMA);
  return ["start", "hold", "other"].includes(raw?.decision) ? raw.decision : "other";
}
