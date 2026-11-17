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
  const gcpCredentials = expand(cfg.gcp?.credentials ?? join(secrets, "gcloud/application_default_credentials.json"));
  const awsHome = expand(cfg.aws?.home ?? join(secrets, "aws"));
  if (!["bwrap", "permissions"].includes(cfg.sandbox?.credential_isolation ?? "bwrap")) throw new Error("sandbox.credential_isolation must be bwrap or permissions");
  const awsAuth = cfg.aws?.auth ?? "sso";
  if (!["sso", "iam"].includes(awsAuth)) throw new Error("aws.auth must be sso or iam");
  if (awsAuth === "iam" && cfg.aws?.accounts?.some((a) => a.write_role)) throw new Error("AWS IAM authentication is read-only; remove write_role");
  if (awsAuth === "iam" && cfg.aws?.accounts?.some((a) => !/^[\w-]+$/.test(a?.name ?? "") || !/^\d{12}$/.test(a?.id ?? "") || !a?.read_role || !/^[a-z0-9-]+$/.test(a?.region ?? cfg.aws.region ?? ""))) {
    throw new Error("AWS IAM accounts require name, a quoted 12-digit id, region and read_role");
  }
  return {
    ...cfg,
    file,
    companyId,
    selfName,
    cad: { python: resolve(REPO_ROOT, expand(cfg.cad?.python ?? "scripts/cad/python")) },
    primerEnabled: cfg.primer?.enabled !== false,
    paperclipUrl: env.PAPERCLIP_URL ?? cfg.paperclip_url ?? "http://localhost:3100",
    // For the connection checks on the board's Settings page: the secrets directory, and the ChatGPT
    // sign-in Paperclip's agents run on (in Paperclip's data directory, which the container mounts).
    secretsDir: secrets,
    paperclipCodexAuthFile: join(resolve(REPO_ROOT, expand(env.PENNYWORTH_DATA_DIR ?? "data")), "paperclip/.codex/auth.json"),
    boardKeyFile: join(secrets, "paperclip_board_key"),
    boardTokenFile: join(secrets, "board_internal_token"),
    boardInternalUrl: env.BOARD_INTERNAL_URL ?? cfg.recurring?.board_url ?? "http://127.0.0.1:3122",
    openrouterKeyFile: expand(cfg.engines?.openrouter?.key_file ?? join(secrets, "openrouter_key")),
    claudeAuth: cfg.engines?.claude?.auth ?? "token",
    claudeTokenFile: expand(cfg.engines?.claude?.token_file ?? join(secrets, "claude_oauth_token")),
    // A Claude Code session past this much context starts afresh on the next turn, with the
    // conversation and the workspace (resuming it again re-reads all of it on every call).
    freshSessionTokens: Number(cfg.engines?.claude?.fresh_session_tokens ?? 300_000),
    claudeConfigDir: expand(cfg.engines?.claude?.config_dir ?? join(cfg.state_dir ?? "~/.local/state/pennyworth-runner", "claude")),
    // Primer for every Engineer job, read-only (D-40): primer-mcp's loopback port.
    primerMcpUrl: env.PRIMER_RUNNER_URL ?? cfg.primer?.url ?? "http://127.0.0.1:3123/mcp/read",
    // The runner itself publishes a task's document there (D-44); jobs never get this endpoint.
    primerPublishUrl: env.PRIMER_RUNNER_PUBLISH_URL ?? cfg.primer?.publish_url ?? "http://127.0.0.1:3123/mcp",
    primerPublishTokenFile: join(secrets, "primer_mcp_token"),
    // Jobs hold their own token, which /mcp (publishing) refuses (D-51).
    primerTokenFile: join(secrets, "primer_mcp_read_token"),
    // Grafana and Google Cloud reads for Claude Code and Codex jobs (D-48).
    grafanaMcpUrl: env.GRAFANA_RUNNER_URL ?? cfg.grafana?.url ?? "http://127.0.0.1:3124/mcp",
    grafanaTokenFile: join(secrets, "grafana_mcp_token"),
    // Slack and Glean reads for Claude Code and Codex jobs (D-51): /mcp/read with tokens of their own.
    slackMcpUrl: env.SLACK_RUNNER_URL ?? cfg.slack?.url ?? "http://127.0.0.1:3125/mcp/read",
    slackTokenFile: join(secrets, "slack_mcp_read_token"),
    gleanMcpUrl: env.GLEAN_RUNNER_URL ?? cfg.glean?.url ?? "http://127.0.0.1:3126/mcp/read",
    gleanTokenFile: join(secrets, "glean_mcp_read_token"),
    // ClickHouse reads for Claude Code and Codex jobs (D-57): clickhouse-mcp's loopback port.
    clickhouseMcpUrl: env.CLICKHOUSE_RUNNER_URL ?? cfg.clickhouse?.url ?? "http://127.0.0.1:3127/mcp",
    clickhouseTokenFile: join(secrets, "clickhouse_mcp_token"),
    // Cloudflare reads for Claude Code and Codex jobs (D-64): cloudflare-mcp's loopback port.
    cloudflareMcpUrl: env.CLOUDFLARE_RUNNER_URL ?? cfg.cloudflare?.url ?? "http://127.0.0.1:3128/mcp",
    cloudflareTokenFile: join(secrets, "cloudflare_mcp_token"),
    gcp: {
      credentialsFile: gcpCredentials,
      projects: (cfg.gcp?.projects ?? []).filter(Boolean),
      shell: cfg.gcp?.shell ?? "pulumi",
      // Hidden from every job (D-48): the user's own gcloud sign-in, and Pennyworth's, whose refresh
      // token can be widened back to cloud-platform.
      hidden: [join(homedir(), ".config/gcloud"), dirname(gcpCredentials)],
    },
    // AWS for Claude Code and Codex jobs (D-59): Pennyworth's own Identity Center sign-in, in a home of
    // its own; read roles for jobs, write roles only for the `pennyworth aws` commands the user asks for.
    aws: {
      auth: awsAuth,
      home: awsHome,
      sso: { startUrl: cfg.aws?.sso_start_url, region: cfg.aws?.sso_region },
      accounts: (awsAuth === "iam" || cfg.aws?.sso_start_url ? cfg.aws?.accounts ?? [] : [])
        .filter((a) => a?.name && a?.id)
        .map((a) => ({ name: String(a.name), id: String(a.id), region: a.region ?? cfg.aws.region ?? cfg.aws.sso_region, readRole: a.read_role, writeRole: a.write_role })),
      // Hidden from every job, like the gcloud sign-ins: the user's own AWS sign-in, and Pennyworth's.
      hidden: [join(homedir(), ".aws"), awsHome],
    },
    workDir: expand(cfg.work_dir ?? "~/pennyworth"),
    stateDir: expand(cfg.state_dir ?? "~/.local/state/pennyworth-runner"),
    codexHome: expand(cfg.engines?.codex?.config_dir ?? join(cfg.state_dir ?? "~/.local/state/pennyworth-runner", "codex")),
    devshells: { ...cfg.devshells, flake: expand(cfg.devshells.flake) },
    ghWrapperDir: join(REPO_ROOT, "services/runner/bin"),
  };
}
