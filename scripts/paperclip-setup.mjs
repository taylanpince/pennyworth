#!/usr/bin/env node
// Idempotently provision Paperclip for Pennyworth from config/paperclip.yaml:
// board login/claim, board API key, company, labels, agents, the ops-mcp agent key,
// tool connections, routines and the transcript-watcher webhook.
//
//   node scripts/paperclip-setup.mjs            (prompts for your Paperclip login once)
//
// Env overrides: PAPERCLIP_URL, PAPERCLIP_EMAIL, PAPERCLIP_PASSWORD, PAPERCLIP_NAME,
// PENNYWORTH_ENV_FILE, PENNYWORTH_SKIP_RESTART=1.
// Secrets are written to PENNYWORTH_SECRETS_DIR (0600) and never printed.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromOps = createRequire(join(repo, "services/ops-mcp/package.json"));
let YAML;
try {
  YAML = requireFromOps("yaml");
} catch {
  console.error("Missing dependency: run `npm ci --prefix services/ops-mcp` first.");
  process.exit(1);
}

// ------------------------------------------------------------------ env & files

function loadEnv(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const envFile = process.env.PENNYWORTH_ENV_FILE ?? join(repo, ".env");
const dotenv = loadEnv(envFile);
const env = (k, d) => process.env[k] ?? dotenv[k] ?? d;
const secretsDir = env("PENNYWORTH_SECRETS_DIR");
if (!secretsDir) fail("PENNYWORTH_SECRETS_DIR is not set (.env)");
const baseUrl = env("PAPERCLIP_URL", "http://localhost:3100");
const origin = new URL(baseUrl).origin;
const configDir = resolve(repo, env("PENNYWORTH_CONFIG_DIR", "config"));
const cfgPath = existsSync(join(configDir, "paperclip.yaml")) ? join(configDir, "paperclip.yaml") : join(configDir, "paperclip.example.yaml");
const cfg = YAML.parse(readFileSync(cfgPath, "utf8"));

const secretPath = (name) => join(secretsDir, name);
const readSecret = (name) => (existsSync(secretPath(name)) ? readFileSync(secretPath(name), "utf8").trim() : "");
function writeSecret(name, value) {
  writeFileSync(secretPath(name), value, { mode: 0o600 });
  chmodSync(secretPath(name), 0o600);
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}
const step = (msg) => console.log(`• ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ HTTP

let boardKey = "";
let sessionCookie = "";

async function api(method, path, body, { auth = "board", allow = [] } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth === "board" && boardKey) headers.authorization = `Bearer ${boardKey}`;
  if (auth === "session") headers.cookie = sessionCookie;
  // Better Auth and the board-mutation guard both check Origin for browser-style calls.
  if (auth !== "board") headers.origin = origin;
  const res = await fetch(new URL(path, baseUrl), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  if (!res.ok && !allow.includes(res.status)) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return { status: res.status, json, headers: res.headers };
}

// ------------------------------------------------------------------ prompts

function ask(question, { hidden = false } = {}) {
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolveAnswer(answer.trim());
    });
  });
}

// ------------------------------------------------------------------ steps

async function waitForHealth() {
  step(`Waiting for Paperclip at ${baseUrl}`);
  for (let i = 0; i < 90; i++) {
    try {
      const { json } = await api("GET", "/api/health", undefined, { auth: "none" });
      if (json.status === "ok") return json;
    } catch {
      /* not up yet */
    }
    await sleep(2000);
  }
  fail("Paperclip did not become healthy (docker compose logs paperclip)");
}

async function ensureBoardKey(health) {
  boardKey = readSecret("paperclip_board_key");
  if (boardKey) {
    const me = await api("GET", "/api/cli-auth/me", undefined, { allow: [401, 403] });
    if (me.status === 200 && me.json.isInstanceAdmin) {
      step("Board API key is valid");
      return;
    }
    boardKey = "";
  }
  const email = env("PAPERCLIP_EMAIL") || (await ask("Paperclip email: "));
  const password = env("PAPERCLIP_PASSWORD") || (await ask("Paperclip password (8+ chars): ", { hidden: true }));
  let res = await api("POST", "/api/auth/sign-in/email", { email, password, rememberMe: true }, { auth: "none", allow: [401] });
  if (res.status === 401) {
    if (health.bootstrapStatus !== "bootstrap_pending") fail("sign-in failed (wrong password?)");
    const name = env("PAPERCLIP_NAME") || (await ask("No account yet. Your name: "));
    step("Creating your Paperclip account");
    await sleep(3500); // auth endpoints allow 3 requests / 10 s
    res = await api("POST", "/api/auth/sign-up/email", { name, email, password, rememberMe: true }, { auth: "none" });
  }
  sessionCookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .filter((c) => c.includes("session_token"))
    .join("; ");
  if (!sessionCookie) fail("no session cookie returned by sign-in");

  const me = await api("GET", "/api/cli-auth/me", undefined, { auth: "session" });
  if (!me.json.isInstanceAdmin) {
    const claim = await api("POST", "/api/bootstrap/claim", {}, { auth: "session", allow: [409] });
    if (claim.status === 409) fail("this Paperclip instance is already owned by another account");
    step("Claimed instance ownership");
  }
  const key = await api("POST", "/api/board-api-keys", { name: "pennyworth-setup", expiresAt: null }, { auth: "session" });
  boardKey = key.json.token;
  writeSecret("paperclip_board_key", boardKey);
  step("Created board API key (saved to secrets dir)");
}

async function ensureCompany() {
  const { json } = await api("GET", "/api/companies");
  let company = json.find((c) => c.name === cfg.company.name && c.status !== "archived");
  if (!company) {
    company = (await api("POST", "/api/companies", { name: cfg.company.name, description: cfg.company.description ?? null })).json;
    step(`Created company ${company.name} (${company.issuePrefix})`);
  } else {
    step(`Company ${company.name} exists (${company.issuePrefix})`);
  }
  return company;
}

async function ensureLabels(companyId) {
  const { json: existing } = await api("GET", `/api/companies/${companyId}/labels`);
  for (const l of cfg.labels ?? []) {
    if (existing.some((e) => e.name === l.name)) continue;
    await api("POST", `/api/companies/${companyId}/labels`, { name: l.name, color: l.color });
    step(`Created label ${l.name}`);
  }
}

function agentBody(key, a) {
  if (a.adapter !== "codex_local") fail(`agent ${key}: only codex_local agents receive Paperclip tool connections`);
  const base = cfg.codex_args ?? ["--sandbox", "read-only"];
  if (!base.includes("--sandbox")) fail("codex_args must include --sandbox (never run agents without Codex's sandbox)");
  // Per-agent tool scoping: every MCP server in the shared Codex config is disabled
  // for this agent unless listed in its mcp_servers; enabled_tools narrows further.
  const allowed = a.mcp_servers;
  if (!Array.isArray(allowed)) fail(`agent ${key}: mcp_servers must list the MCP servers it may use`);
  const known = Object.keys(cfg.mcp_servers ?? {});
  for (const n of allowed) if (!known.includes(n)) fail(`agent ${key}: unknown MCP server ${n}`);
  const scoping = [];
  for (const n of known) if (!allowed.includes(n)) scoping.push("-c", `mcp_servers.${n}.enabled=false`);
  for (const [n, tools] of Object.entries(a.enabled_tools ?? {})) {
    if (!allowed.includes(n)) fail(`agent ${key}: enabled_tools for ${n}, which is not in its mcp_servers`);
    scoping.push("-c", `mcp_servers.${n}.enabled_tools=${JSON.stringify(tools)}`);
  }
  const extraArgs = [...base, ...scoping];
  const adapterConfig = {
    engine: "cli",
    dangerouslyBypassApprovalsAndSandbox: false,
    extraArgs,
    timeoutSec: a.timeout_sec ?? 1800,
  };
  if (a.model) adapterConfig.model = a.model;
  if (a.reasoning_effort) adapterConfig.modelReasoningEffort = a.reasoning_effort;
  return {
    name: a.name,
    role: "general",
    title: a.title ?? null,
    adapterType: "codex_local",
    adapterConfig,
    runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true, maxConcurrentRuns: 1 } },
    metadata: { setupKey: `pennyworth:${key}` },
  };
}

async function ensureAgents(companyId) {
  const { json: agents } = await api("GET", `/api/companies/${companyId}/agents`);
  const result = {};
  for (const [key, a] of Object.entries(cfg.agents ?? {})) {
    const instructions = readFileSync(resolve(repo, a.instructions), "utf8");
    const body = agentBody(key, a);
    let agent = agents.find((x) => x.metadata?.setupKey === `pennyworth:${key}` && x.status !== "terminated") ?? agents.find((x) => x.name === a.name && x.status !== "terminated");
    if (!agent) {
      agent = (await api("POST", `/api/companies/${companyId}/agents`, { ...body, instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": instructions } } })).json;
      step(`Created agent ${a.name}`);
    } else {
      await api("PATCH", `/api/agents/${agent.id}`, { title: body.title, adapterConfig: body.adapterConfig, runtimeConfig: body.runtimeConfig, metadata: body.metadata });
      await api("PUT", `/api/agents/${agent.id}/instructions-bundle/file`, { path: "AGENTS.md", content: instructions });
      step(`Updated agent ${a.name}`);
    }
    result[key] = agent;
  }
  return result;
}

async function ensureOpsKey(agent) {
  // ops-mcp creates tasks as the Meeting Librarian (agent key, standard trust).
  const existing = readSecret("paperclip_ops_key");
  if (existing) {
    const res = await fetch(new URL("/api/agents/me", baseUrl), { headers: { authorization: `Bearer ${existing}` } });
    if (res.ok) {
      step("ops-mcp agent key is valid");
      return false;
    }
  }
  const { json } = await api("POST", `/api/agents/${agent.id}/keys`, { name: "ops-mcp" });
  writeSecret("paperclip_ops_key", json.token);
  step("Created ops-mcp agent key (saved to secrets dir)");
  return true;
}

function updateSystemYaml(companyId) {
  const path = join(configDir, "system.yaml");
  if (!existsSync(path)) fail("config/system.yaml missing (run scripts/bootstrap.sh)");
  const text = readFileSync(path, "utf8");
  const doc = YAML.parseDocument(text);
  if (doc.getIn(["paperclip", "company_id"]) === companyId) return false;
  doc.setIn(["paperclip", "company_id"], companyId);
  writeFileSync(path, doc.toString());
  step("Wrote company_id to config/system.yaml");
  return true;
}

/**
 * Earlier setups registered these MCP servers as Paperclip Tool Connections. Codex now
 * gets them directly (see mcp_servers in config/paperclip.yaml), so remove gateway
 * installs to avoid duplicate tools that Codex would refuse to call.
 */
async function removeGatewayInstalls(companyId) {
  const legacy = ["ops-mcp", "google-workspace-mcp"];
  const { json } = await api("GET", `/api/companies/${companyId}/tools/connections`);
  for (const conn of json.connections.filter((c) => legacy.includes(c.name))) {
    const { json: inst } = await api("GET", `/api/tool-connections/${conn.id}/installs`);
    if ((inst.installs ?? []).length === 0) continue;
    await api("PUT", `/api/tool-connections/${conn.id}/installs`, { installs: [] });
    step(`Removed Paperclip gateway installs for ${conn.name} (Codex uses it directly)`);
  }
}

async function ensureRoutines(companyId, agents) {
  const { json: routines } = await api("GET", `/api/companies/${companyId}/routines`);
  for (const [key, r] of Object.entries(cfg.routines ?? {})) {
    const agent = agents[r.agent];
    if (!agent) fail(`routine ${key}: unknown agent ${r.agent}`);
    const body = {
      title: r.title,
      description: r.description,
      assigneeAgentId: agent.id,
      priority: "medium",
      status: "active",
      concurrencyPolicy: r.concurrency ?? "coalesce_if_active",
      catchUpPolicy: "skip_missed",
    };
    let routine = routines.find((x) => x.title === r.title);
    if (!routine) {
      routine = (await api("POST", `/api/companies/${companyId}/routines`, body)).json;
      step(`Created routine ${r.title}`);
    } else {
      await api("PATCH", `/api/routines/${routine.id}`, body);
    }
    const { json: detail } = await api("GET", `/api/routines/${routine.id}`);
    const triggers = detail.triggers ?? [];

    for (const s of r.schedules ?? []) {
      const existing = triggers.find((t) => t.kind === "schedule" && t.label === s.label);
      if (existing) {
        await api("PATCH", `/api/routine-triggers/${existing.id}`, { cronExpression: s.cron, timezone: s.timezone, enabled: true });
      } else {
        await api("POST", `/api/routines/${routine.id}/triggers`, { kind: "schedule", label: s.label, cronExpression: s.cron, timezone: s.timezone });
        step(`Added schedule "${s.label}" (${s.cron} ${s.timezone}) to ${r.title}`);
      }
    }

    if (r.webhook) {
      const label = "transcript watcher";
      const existing = triggers.find((t) => t.kind === "webhook" && t.label === label);
      let material;
      if (!existing) {
        material = (await api("POST", `/api/routines/${routine.id}/triggers`, { kind: "webhook", label, signingMode: "hmac_sha256", replayWindowSec: 300 })).json.secretMaterial;
        step(`Added signed webhook trigger to ${r.title}`);
      } else if (!readSecret("meeting_webhook_secret")) {
        material = (await api("POST", `/api/routine-triggers/${existing.id}/rotate-secret`, {})).json.secretMaterial;
        step("Rotated webhook secret (local copy was missing)");
      }
      if (material) {
        writeSecret("meeting_webhook_url", material.webhookUrl);
        writeSecret("meeting_webhook_secret", material.webhookSecret);
      }
    }
  }
}

/**
 * Register the paperclip-tasks stdio MCP bridge in the shared Codex config. Paperclip
 * copies this file into each company's managed Codex home before every run.
 */
const toml = (v) => (Array.isArray(v) ? `[${v.map(toml).join(", ")}]` : JSON.stringify(String(v)));

function ensureCodexConfig() {
  const dataDir = resolve(repo, env("PENNYWORTH_DATA_DIR", "./data"));
  const path = join(dataDir, "paperclip", ".codex", "config.toml");
  const lines = ["# >>> pennyworth (managed by scripts/paperclip-setup.mjs)"];
  for (const [name, m] of Object.entries(cfg.mcp_servers ?? {})) {
    if (!/^[a-z0-9_]+$/.test(name)) fail(`invalid MCP server name ${name}`);
    lines.push(`[mcp_servers.${name}]`);
    if (m.url) lines.push(`url = ${toml(m.url)}`);
    if (m.bearer_token_env_var) lines.push(`bearer_token_env_var = ${toml(m.bearer_token_env_var)}`);
    if (m.command) lines.push(`command = ${toml(m.command)}`);
    if (m.args) lines.push(`args = ${toml(m.args)}`);
    if (m.env_vars) lines.push(`env_vars = ${toml(m.env_vars)}`);
    lines.push("startup_timeout_sec = 20", "tool_timeout_sec = 300");
    // Tools are pre-approved: the agents' only capabilities are these vetted servers.
    lines.push('default_tools_approval_mode = "approve"', "");
  }
  lines.push("# <<< pennyworth");
  const block = lines.join("\n");
  const upsert = (file, create) => {
    if (!create && !existsSync(file)) return false;
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    const stripped = current.replace(/# >>> pennyworth[\s\S]*?# <<< pennyworth\n?/, "").trimEnd();
    const next = `${stripped ? `${stripped}\n\n` : ""}${block}\n`;
    if (next === current) return false;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, next, { mode: 0o600 });
    return true;
  };
  if (upsert(path, true)) step(`Wrote MCP servers to the shared Codex config (${Object.keys(cfg.mcp_servers ?? {}).join(", ")})`);
  // Paperclip copies the shared config into a managed Codex home only once, so keep
  // already-seeded homes in sync (Paperclip's own managed block is left untouched).
  const companies = join(dataDir, "paperclip", "instances", env("PAPERCLIP_INSTANCE_ID", "default"), "companies");
  if (!existsSync(companies)) return;
  let updated = 0;
  for (const c of readdirSync(companies)) {
    const homes = [join(companies, c, "codex-home", "config.toml")];
    const agentsDir = join(companies, c, "agents");
    if (existsSync(agentsDir)) for (const a of readdirSync(agentsDir)) homes.push(join(agentsDir, a, "codex-home", "config.toml"));
    for (const h of homes) if (upsert(h, false)) updated++;
  }
  if (updated) step(`Updated MCP servers in ${updated} existing managed Codex home(s)`);
}

function restartOpsMcp() {
  if (env("PENNYWORTH_SKIP_RESTART") === "1") return;
  try {
    execFileSync("docker", ["compose", "up", "-d", "--no-deps", "--force-recreate", "ops-mcp"], { cwd: repo, stdio: "ignore", env: { ...process.env, ...dotenv } });
    step("Restarted ops-mcp to pick up the new key/config");
  } catch {
    console.warn("  warning: could not restart ops-mcp; run `docker compose up -d --force-recreate ops-mcp`");
  }
}


// ------------------------------------------------------------------ main

const health = await waitForHealth();
await ensureBoardKey(health);
const company = await ensureCompany();
await ensureLabels(company.id);
const agents = await ensureAgents(company.id);
const librarian = agents["meeting-librarian"];
const keyChanged = librarian ? await ensureOpsKey(librarian) : false;
const cfgChanged = updateSystemYaml(company.id);
if (keyChanged || cfgChanged) restartOpsMcp();
ensureCodexConfig();
await removeGatewayInstalls(company.id);
await ensureRoutines(company.id, agents);

const codexAuth = execFileSafe(["compose", "exec", "-T", "-u", "node", "paperclip", "test", "-s", "/paperclip/.codex/auth.json"]);
console.log("\nPaperclip is configured.");
if (!codexAuth) {
  console.log("Next: log Codex in with your ChatGPT account (once):");
  console.log("  docker compose exec -it -u node paperclip codex -c 'cli_auth_credentials_store=\"file\"' login --device-auth");
}
if (readSecret("google_oauth.json") === "{}" || !readSecret("google_oauth.json")) {
  console.log("Google Calendar/Drive is not connected yet: see README.md › Google.");
}

function execFileSafe(args) {
  try {
    execFileSync("docker", args, { cwd: repo, stdio: "ignore", env: { ...process.env, ...dotenv } });
    return true;
  } catch {
    return false;
  }
}
