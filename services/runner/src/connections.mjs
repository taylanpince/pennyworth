import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { roleCredentials } from "./aws.mjs";
import { accessToken } from "./gcp.mjs";

/**
 * The sign-ins that live on the laptop, checked for the board's Settings page: GitHub (Alfred's token
 * and the Engineers' gh), Primer, Slack, Google Cloud, AWS and the engines. Each check is the cheapest
 * real call that proves the sign-in works (who am I, a token refresh, a read role), never a write.
 * The board gets states and account names only, never a credential.
 */

const read = (file) => (file && existsSync(file) ? readFileSync(file, "utf8").trim() : "");
const short = (err) => String(err?.message ?? err).replace(/\s+/g, " ").slice(0, 280);

function run(argv, timeout = 20_000) {
  return new Promise((resolve, reject) =>
    execFile(argv[0], argv.slice(1), { timeout, encoding: "utf8" }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout.trim()))),
  );
}

/** One tool call on a loopback MCP endpoint (stateless streamable HTTP). */
async function mcpTool(url, token, name, args, fetchImpl) {
  let id = 0;
  const rpc = async (method, params) => {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${text.slice(0, 200)}`), { status: res.status });
    const json = JSON.parse(text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:")).slice(5) : text);
    if (json.error) throw new Error(JSON.stringify(json.error).slice(0, 200));
    return json.result;
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pennyworth-runner", version: "0" } });
  const r = await rpc("tools/call", { name, arguments: args });
  const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
  if (r.isError) throw new Error(text.slice(0, 200) || "tool failed");
  return text;
}

/** The email in a Codex auth.json's ID token (read locally; nothing is sent anywhere). */
function codexAccount(file) {
  const auth = JSON.parse(readFileSync(file, "utf8"));
  const idToken = auth.tokens?.id_token;
  if (typeof idToken !== "string") return auth.OPENAI_API_KEY ? "API key" : undefined;
  const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
  return claims.email ?? claims["https://api.openai.com/profile"]?.email;
}

const firstMatch = (text, ...patterns) => {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m?.[1]) return m[1].trim().slice(0, 200);
  }
  return undefined;
};

const failed = (err) => ({ state: err?.status === 401 || /401|unauthori[sz]ed|invalid_auth|token_revoked|expired/i.test(short(err)) ? "expired" : "error", detail: short(err) });

export async function checkConnections(cfg, { fetchImpl = fetch, exec = run, aws = roleCredentials, gcp = accessToken, home = homedir() } = {}) {
  const checks = [];
  const add = async (id, fn) => {
    try {
      checks.push({ id, ...(await fn()) });
    } catch (err) {
      checks.push({ id, ...failed(err) });
    }
  };

  await Promise.all([
    add("github", async () => {
      const token = read(join(cfg.secretsDir, "github_token"));
      if (!token) return { state: "missing", detail: "no token: run scripts/github-auth.sh" };
      const res = await fetchImpl("https://api.github.com/user", { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "pennyworth-runner" }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 401) return { state: "expired", detail: "GitHub rejected the token: run scripts/github-auth.sh" };
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const login = (await res.json()).login;
      return { state: "ok", accounts: [{ label: `@${login}`, state: "ok" }] };
    }),
    add("gh", async () => {
      const login = await exec(["gh", "api", "user", "--jq", ".login"]).catch((err) => {
        throw Object.assign(new Error(`gh: ${short(err)}`), { status: /auth login|401/i.test(short(err)) ? 401 : undefined });
      });
      return { state: "ok", accounts: [{ label: `@${login}`, state: "ok" }] };
    }),
    add("primer", async () => {
      if (cfg.primerEnabled === false) return { state: "unset", detail: "Primer is off for this instance" };
      const token = read(cfg.primerTokenFile);
      if (!token) return { state: "missing", detail: "no read token: run scripts/bootstrap.sh" };
      const text = await mcpTool(cfg.primerMcpUrl, token, "primer_whoami", {}, fetchImpl);
      const who = firstMatch(text, /"email"\s*:\s*"([^"]+)"/, /"name"\s*:\s*"([^"]+)"/);
      return { state: "ok", ...(who ? { accounts: [{ label: who, state: "ok" }] } : {}) };
    }),
    add("slack", async () => {
      const token = read(cfg.slackTokenFile);
      if (!token) return { state: "unset", detail: "no read token for jobs" };
      const text = await mcpTool(cfg.slackMcpUrl, token, "slack_read_user_profile", { response_format: "concise" }, fetchImpl);
      // The concise profile is lines of text: "name (handle)", then the workspace.
      let profile = text;
      try {
        const j = JSON.parse(text);
        if (typeof j.result === "string") profile = j.result;
      } catch {}
      const [name, workspace] = profile.split("\n").map((l) => l.trim());
      const who = name ? `${name}${workspace ? ` · ${workspace}` : ""}`.slice(0, 200) : undefined;
      return { state: "ok", ...(who ? { accounts: [{ label: who, state: "ok" }] } : {}) };
    }),
    add("gcloud", async () => {
      if (!cfg.gcp?.credentialsFile || !existsSync(cfg.gcp.credentialsFile)) return { state: "missing", detail: "not signed in: run scripts/gcloud-auth.sh" };
      let token;
      try {
        token = (await gcp(cfg.gcp.credentialsFile, fetchImpl)).token;
      } catch (err) {
        return { state: err.state === "unavailable" ? "error" : err.state === "missing" ? "missing" : "expired", detail: short(err) };
      }
      // The sign-in's email, from Google's token info (the token goes in the body, to Google only).
      const info = await fetchImpl("https://oauth2.googleapis.com/tokeninfo", { method: "POST", body: new URLSearchParams({ access_token: token }), signal: AbortSignal.timeout(15_000) })
        .then((r) => r.json())
        .catch(() => ({}));
      const projects = (cfg.gcp.projects ?? []).length ? ` · projects: ${cfg.gcp.projects.join(", ")}` : "";
      return { state: "ok", accounts: [{ label: `${info.email ?? "signed in"}${projects}`.slice(0, 200), state: "ok" }] };
    }),
    add("aws", async () => {
      const accounts = (cfg.aws?.accounts ?? []).filter((a) => a.readRole);
      if (!accounts.length) return { state: "unset", detail: cfg.aws?.sso?.startUrl ? "no accounts listed under aws.accounts in config/runner.yaml" : "set aws.sso_start_url and aws.accounts in config/runner.yaml" };
      const results = await Promise.all(
        accounts.map((account) =>
          aws({ aws: cfg.aws, account, kind: "read" }).then(
            () => ({ label: `${account.name} (${account.id})`, state: "ok" }),
            (err) => ({ label: `${account.name} (${account.id})`, ...failed(err) }),
          ),
        ),
      );
      return { state: "ok", accounts: results };
    }),
    add("claude", async () => {
      if (!read(cfg.claudeTokenFile)) return { state: "missing", detail: "no token: run claude setup-token" };
      return { state: "ok", detail: "token saved; it's checked when a Claude job runs" };
    }),
    add("codex", async () => {
      const file = join(process.env.CODEX_HOME ?? join(home, ".codex"), "auth.json");
      if (!existsSync(file)) return { state: "missing", detail: "not signed in: run codex login" };
      const who = codexAccount(file);
      return { state: "ok", ...(who ? { accounts: [{ label: who, state: "ok" }] } : {}) };
    }),
    add("paperclip-codex", async () => {
      if (!cfg.paperclipCodexAuthFile || !existsSync(cfg.paperclipCodexAuthFile)) return { state: "missing", detail: "Paperclip's agents aren't signed in to ChatGPT" };
      const who = codexAccount(cfg.paperclipCodexAuthFile);
      return { state: "ok", ...(who ? { accounts: [{ label: who, state: "ok" }] } : {}) };
    }),
    add("openrouter", async () => {
      const key = read(cfg.openrouterKeyFile);
      if (!key) return { state: "unset", detail: "no key saved" };
      const res = await fetchImpl("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 401) return { state: "expired", detail: "OpenRouter rejected the key" };
      if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
      const data = (await res.json()).data ?? {};
      // OpenRouter's default label is a masked piece of the key itself: never shown.
      return { state: "ok", ...(data.label && !/^sk-/.test(String(data.label)) ? { accounts: [{ label: String(data.label).slice(0, 200), state: "ok" }] } : {}) };
    }),
  ]);
  return checks;
}
