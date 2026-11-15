import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./config.mjs";

export const isCadRole = (agent) => agent?.metadata?.runnerEngine === true && agent?.metadata?.role?.workflow === "cad";
export const CAD_TOOLS = ["status", "engine", "pass", "reset", "cleanup", "task", "tasks", "remember", "propose", "memory"];

/** Trusted role instructions, repeated on resumed turns as well as new sessions. */
export function cadRuntime(cfg) {
  const python = cfg.cad.python;
  if (!existsSync(python)) throw new Error("CAD Python is not configured: set cad.python in config/runner.yaml and run scripts/cad/setup.sh.");
  return {
    instructions: readFileSync(join(REPO_ROOT, "config/agents/cad-designer.md"), "utf8"),
    env: { CAD_PYTHON: python, CAD_EXPORT: join(REPO_ROOT, "services/runner/cad/export.py") },
  };
}
