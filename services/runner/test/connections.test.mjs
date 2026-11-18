import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkConnections } from "../src/connections.mjs";
import { GcpAuthError } from "../src/gcp.mjs";

const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "connections-"));
  const secrets = join(dir, "secrets");
  mkdirSync(secrets);
  const home = join(dir, "home");
  mkdirSync(join(home, ".codex"), { recursive: true });
  const cfg = {
    secretsDir: secrets,
    primerEnabled: true,
    primerTokenFile: join(secrets, "primer_mcp_read_token"),
    primerMcpUrl: "http://primer/mcp/read",
    slackTokenFile: join(secrets, "slack_mcp_read_token"),
    slackMcpUrl: "http://slack/mcp/read",
    claudeTokenFile: join(secrets, "claude_oauth_token"),
    openrouterKeyFile: join(secrets, "openrouter_key"),
    paperclipCodexAuthFile: join(dir, "paperclip-auth.json"),
    gcp: { credentialsFile: join(secrets, "gcloud.json"), projects: ["prod"] },
    aws: { sso: { startUrl: "https://d-1.awsapps.com/start" }, accounts: [{ name: "prod", id: "111111111111", readRole: "ReadOnly" }, { name: "dev", id: "222222222222", readRole: "ReadOnly" }] },
  };
  return { dir, secrets, home, cfg };
}

/** A fake of every outside service the checks call. */
function fakeFetch(seen, { githubStatus = 200, openrouterLabel = "work" } = {}) {
  return async (url, init) => {
    seen.push(String(url));
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "https://api.github.com/user") return githubStatus === 200 ? json({ login: "octo" }) : json({ message: "Bad credentials" }, githubStatus);
    if (url === "https://oauth2.googleapis.com/tokeninfo") return json({ email: "me@example.com" });
    if (url === "https://openrouter.ai/api/v1/key") return json({ data: { label: openrouterLabel } });
    const { method } = JSON.parse(init.body);
    if (method === "initialize") return json({ jsonrpc: "2.0", id: 1, result: {} });
    if (String(url).startsWith("http://primer")) return json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: '{"email":"me@example.com"}' }] } });
    if (String(url).startsWith("http://slack")) return json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ result: "Me (me)\nAcme\nEngineer" }) }] } });
    throw new Error(`unexpected ${url}`);
  };
}

describe("connection checks for Settings", () => {
  it("checks channel reads when Slack's profile tool lacks scopes, without leaking channel data", async () => {
    const { secrets, home, cfg } = setup();
    writeFileSync(join(secrets, "slack_mcp_read_token"), "secret-value");
    for (const channelFails of [false, true]) {
      const calls = [];
      const checks = await checkConnections(cfg, {
        home,
        exec: async () => "octo",
        fetchImpl: async (url, init) => {
          if (!String(url).startsWith("http://slack")) throw new Error("not configured");
          const { method, params } = JSON.parse(init.body);
          if (method === "initialize") return Response.json({ result: {} });
          calls.push(params);
          const failed = params.name === "slack_read_user_profile" || channelFails;
          return Response.json({ result: { isError: failed, content: [{ type: "text", text: failed ? "missing_scopes" : "private-channel-id" }] } });
        },
      });
      const slack = checks.find((c) => c.id === "slack");
      assert.equal(slack.state, channelFails ? "error" : "ok");
      assert.equal(slack.accounts, undefined);
      assert.ok(!JSON.stringify(slack).includes("private-channel-id"));
      assert.deepEqual(calls[1], { name: "slack_list_user_channels", arguments: { limit: 1, format: "ids_only" } });
    }
  });

  it("reports explicitly disabled Slack reads without calling the endpoint", async () => {
    const { secrets, home, cfg } = setup();
    writeFileSync(join(secrets, "slack_mcp_read_token"), "secret-value");
    cfg.slackMcpUrl = "";
    const seen = [];
    const checks = await checkConnections(cfg, { home, exec: async () => "octo", fetchImpl: fakeFetch(seen) });
    assert.deepEqual(checks.find((c) => c.id === "slack"), { id: "slack", state: "unset", detail: "Slack reads disabled for jobs" });
    assert.ok(!seen.some((url) => url.startsWith("http://slack")));
  });

  it("reports who each sign-in is, with every AWS account and no credentials", async () => {
    const { secrets, home, cfg } = setup();
    for (const f of ["github_token", "primer_mcp_read_token", "slack_mcp_read_token", "claude_oauth_token", "openrouter_key", "gcloud.json"]) writeFileSync(join(secrets, f), "secret-value\n");
    writeFileSync(join(home, ".codex/auth.json"), JSON.stringify({ tokens: { id_token: jwt({ email: "me@example.com" }) } }));
    writeFileSync(cfg.paperclipCodexAuthFile, JSON.stringify({ tokens: { id_token: jwt({ email: "agents@example.com" }) } }));
    const seen = [];
    const checks = await checkConnections(cfg, {
      fetchImpl: fakeFetch(seen),
      exec: async (argv) => (assert.deepEqual(argv, ["gh", "api", "user", "--jq", ".login"]), "octo"),
      gcp: async () => ({ token: "access" }),
      aws: async ({ account }) => {
        if (account.name === "dev") throw new Error("Token has expired and refresh failed");
        return {};
      },
      home,
    });
    const by = Object.fromEntries(checks.map((c) => [c.id, c]));
    assert.deepEqual(by.github, { id: "github", state: "ok", accounts: [{ label: "@octo", state: "ok" }] });
    assert.deepEqual(by.gh.accounts, [{ label: "@octo", state: "ok" }]);
    assert.deepEqual(by.slack.accounts, [{ label: "Me (me) · Acme", state: "ok" }]);
    assert.deepEqual(by.gcloud.accounts, [{ label: "me@example.com · projects: prod", state: "ok" }]);
    assert.equal(by.aws.accounts[0].state, "ok");
    assert.equal(by.aws.accounts[1].state, "expired");
    assert.equal(by.claude.state, "ok");
    assert.deepEqual(by.codex.accounts, [{ label: "me@example.com", state: "ok" }]);
    assert.deepEqual(by["paperclip-codex"].accounts, [{ label: "agents@example.com", state: "ok" }]);
    assert.deepEqual(by.openrouter.accounts, [{ label: "work", state: "ok" }]);
    assert.ok(!JSON.stringify(checks).includes("secret-value"), "no credential in the report");
  });

  it("says what's missing or ended, and never shows a key's masked label", async () => {
    const { secrets, home, cfg } = setup();
    writeFileSync(join(secrets, "github_token"), "old\n");
    writeFileSync(join(secrets, "openrouter_key"), "k\n");
    writeFileSync(join(secrets, "gcloud.json"), "{}");
    cfg.aws.accounts = [];
    const checks = await checkConnections(cfg, {
      fetchImpl: fakeFetch([], { githubStatus: 401, openrouterLabel: "sk-or-v1-412...483" }),
      exec: async () => {
        throw new Error("To get started with GitHub CLI, please run:  gh auth login");
      },
      gcp: async () => {
        throw new GcpAuthError("the Google Cloud session ended (16-hour reauth): run scripts/gcloud-auth.sh");
      },
      home,
    });
    const by = Object.fromEntries(checks.map((c) => [c.id, c]));
    assert.equal(by.github.state, "expired");
    assert.equal(by.gh.state, "expired");
    assert.equal(by.gcloud.state, "expired");
    assert.match(by.gcloud.detail, /16-hour/);
    assert.equal(by.aws.state, "unset");
    assert.equal(by.slack.state, "unset");
    assert.equal(by.claude.state, "missing");
    assert.equal(by.codex.state, "missing");
    assert.equal(by["paperclip-codex"].state, "missing");
    assert.equal(by.openrouter.state, "ok");
    assert.equal(by.openrouter.accounts, undefined);
  });
});
