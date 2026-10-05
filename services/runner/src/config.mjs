import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const expand = (p) => (typeof p === "string" && p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

function loadEnv(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
  );
}

/** Runner configuration: config/runner.yaml (or the example) plus .env and system.yaml. */
export function loadConfig() {
  const env = { ...loadEnv(process.env.PENNYWORTH_ENV_FILE ?? join(REPO_ROOT, ".env")), ...process.env };
  const configDir = resolve(REPO_ROOT, env.PENNYWORTH_CONFIG_DIR ?? "config");
  const file = existsSync(join(configDir, "runner.yaml")) ? join(configDir, "runner.yaml") : join(REPO_ROOT, "config/runner.example.yaml");
  const cfg = parseYaml(readFileSync(file, "utf8"));
  const system = readFileSync(join(configDir, "system.yaml"), "utf8");
  const companyId = /^\s*company_id:\s*"?([0-9a-f-]{36})"?/m.exec(system)?.[1];
  const selfName = /^\s*names:\s*\[\s*"([^"]+)"/m.exec(system)?.[1] ?? "the user";
  if (!companyId) throw new Error("paperclip.company_id missing in config/system.yaml (run scripts/paperclip-setup.mjs)");
  const secrets = expand(env.PENNYWORTH_SECRETS_DIR ?? "~/.config/pennyworth");
  return {
    ...cfg,
    file,
    companyId,
    selfName,
    paperclipUrl: env.PAPERCLIP_URL ?? cfg.paperclip_url ?? "http://localhost:3100",
    boardKeyFile: join(secrets, "paperclip_board_key"),
    openrouterKeyFile: expand(cfg.engines?.openrouter?.key_file ?? join(secrets, "openrouter_key")),
    workDir: expand(cfg.work_dir ?? "~/pennyworth"),
    stateDir: expand(cfg.state_dir ?? "~/.local/state/pennyworth-runner"),
    devshells: { ...cfg.devshells, flake: expand(cfg.devshells.flake) },
    ghWrapperDir: join(REPO_ROOT, "services/runner/bin"),
  };
}
