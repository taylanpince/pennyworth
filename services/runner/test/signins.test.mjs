import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { ghExtraScopes, SignInRunner } from "../src/signins.mjs";

/** A process that prints what a test says and remembers what it was given. */
function fakeSpawn() {
  const procs = [];
  const spawnImpl = (cmd, args, opts) => {
    const p = new EventEmitter();
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.stdin = { written: [], write: (t) => p.stdin.written.push(t) };
    p.exitCode = null;
    p.argv = [cmd, ...args];
    p.env = opts.env;
    p.kill = () => ((p.killed = true), (p.exitCode = 143));
    p.say = (text) => p.stdout.write(text);
    p.exit = (code) => ((p.exitCode = code), p.emit("close", code));
    procs.push(p);
    return p;
  };
  return { procs, spawnImpl };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

function setup(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "signins-"));
  const secrets = join(dir, "secrets");
  mkdirSync(join(secrets, "gcloud"), { recursive: true });
  const cfg = {
    secretsDir: secrets,
    devshells: { flake: "", engine_shell: "llm" },
    gcp: { credentialsFile: join(secrets, "gcloud/application_default_credentials.json"), shell: "pulumi" },
    aws: { auth: "sso", sso: { startUrl: "https://d-1.awsapps.com/start", region: "eu-west-1" }, home: join(secrets, "aws"), accounts: [] },
    claudeTokenFile: join(secrets, "claude_oauth_token"),
    openrouterKeyFile: join(secrets, "openrouter_key"),
    ...overrides,
  };
  const reports = [];
  const { procs, spawnImpl } = fakeSpawn();
  return { dir, secrets, cfg, reports, procs, spawnImpl };
}

describe("sign-ins from Settings (D-66)", () => {
  it("keeps the gh token's extra scopes", () => {
    assert.deepEqual(ghExtraScopes("  - Token scopes: 'gist', 'project', 'read:org', 'repo', 'workflow'"), ["project", "workflow"]);
    assert.deepEqual(ghExtraScopes("not logged in"), []);
  });

  it("gh: shows GitHub's link and code, keeps the scopes, and refreshes Alfred's token", async () => {
    const { cfg, reports, procs, spawnImpl, secrets } = setup();
    const run = async (argv) => {
      if (argv.join(" ") === "gh auth status --hostname github.com") return { code: 0, stdout: "", stderr: "  - Token scopes: 'gist', 'project', 'read:org', 'repo'" };
      if (argv.join(" ") === "gh api user --jq .login") return { code: 0, stdout: "octo" };
      if (argv.join(" ") === "gh auth token") return { code: 0, stdout: "gho_new" };
      throw new Error(argv.join(" "));
    };
    const r = new SignInRunner(cfg, (u) => reports.push(u), { spawnImpl, deps: { run } });
    await r.handle({ session: "a".repeat(24), kind: "start", provider: "gh" });
    const p = procs[0];
    assert.deepEqual(p.argv, ["gh", "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", "project"]);
    assert.equal(p.env.BROWSER, "true");
    p.say("\n! First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n");
    await tick();
    assert.deepEqual(reports.at(-1), { session: "a".repeat(24), status: "waiting", url: "https://github.com/login/device", code: "ABCD-1234" });
    assert.deepEqual(p.stdin.written, ["\n"]);
    p.exit(0);
    await tick();
    assert.equal(reports.at(-1).status, "done");
    assert.match(reports.at(-1).message, /@octo/);
    assert.equal(readFileSync(join(secrets, "github_token"), "utf8"), "gho_new");
    assert.equal(statSync(join(secrets, "github_token")).mode & 0o777, 0o600);
  });

  it("github: copies gh's token straight away when gh works", async () => {
    const { cfg, reports, procs, spawnImpl, secrets } = setup();
    const run = async (argv) => (argv.at(-1) === ".login" ? { code: 0, stdout: "octo" } : { code: 0, stdout: "gho_same" });
    const r = new SignInRunner(cfg, (u) => reports.push(u), { spawnImpl, deps: { run } });
    await r.handle({ session: "b".repeat(24), kind: "start", provider: "github" });
    assert.equal(procs.length, 0);
    assert.equal(reports.at(-1).status, "done");
    assert.equal(readFileSync(join(secrets, "github_token"), "utf8"), "gho_same");
  });

  it("gcloud: shows Google's link, asks for the verification code, and passes it on once", async () => {
    const { cfg, reports, procs, spawnImpl } = setup();
    const fetchImpl = async () => new Response(JSON.stringify({ email: "me@example.com" }));
    writeFileSync(cfg.gcp.credentialsFile, "{}");
    const r = new SignInRunner(cfg, (u) => reports.push(u), { spawnImpl, deps: { fetchImpl } });
    // The check after the sign-in: a real refresh, faked here.
    r.drivers.gcloud.finish = async () => "Signed in as me@example.com.";
    await r.handle({ session: "c".repeat(24), kind: "start", provider: "gcloud" });
    const p = procs[0];
    assert.deepEqual(p.argv.slice(-6), ["gcloud", "auth", "application-default", "login", "--no-launch-browser", "--disable-quota-project"]);
    assert.equal(p.env.CLOUDSDK_CONFIG, join(cfg.secretsDir, "gcloud"));
    p.say("Go to the following link in your browser, and complete the sign-in prompts:\n\n    https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=x&state=s\n\nOnce finished, enter the verification code provided in your browser: ");
    await tick();
    assert.deepEqual(reports.at(-1), { session: "c".repeat(24), status: "waiting", url: "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=x&state=s", prompt: { label: "The verification code Google shows after you approve", secret: false } });
    await r.handle({ session: "c".repeat(24), kind: "input", text: " 4/0Abc \n" });
    assert.deepEqual(p.stdin.written, ["4/0Abc\n"]);
    assert.deepEqual(reports.at(-1), { session: "c".repeat(24), status: "waiting", message: "Checking…" });
    p.exit(0);
    await tick();
    assert.deepEqual(reports.at(-1), { session: "c".repeat(24), status: "done", message: "Signed in as me@example.com." });
  });

  it("aws: shows the device link with its code; refuses IAM keys and a missing start URL", async () => {
    const { cfg, reports, procs, spawnImpl } = setup();
    const r = new SignInRunner(cfg, (u) => reports.push(u), { spawnImpl });
    await r.handle({ session: "d".repeat(24), kind: "start", provider: "aws" });
    const p = procs[0];
    assert.equal(p.env.HOME, cfg.aws.home);
    assert.ok(p.argv.includes("--use-device-code") && p.argv.includes("--no-browser"));
    p.say("Browser will not be automatically opened.\nPlease visit the following URL:\n\nhttps://d-1.awsapps.com/start/#/device\n\nThen enter the code:\n\nWXYZ-ABCD\n\nAlternatively, you may visit the following URL which will autofill the code upon loading:\nhttps://d-1.awsapps.com/start/#/device?user_code=WXYZ-ABCD\n");
    await tick();
    assert.deepEqual(reports.at(-1), { session: "d".repeat(24), status: "waiting", url: "https://d-1.awsapps.com/start/#/device?user_code=WXYZ-ABCD", code: "WXYZ-ABCD" });
    p.exit(1);
    await tick();
    assert.equal(reports.at(-1).status, "failed");

    const iam = setup({ aws: { auth: "iam", accounts: [] } });
    const r2 = new SignInRunner(iam.cfg, (u) => iam.reports.push(u), { spawnImpl: iam.spawnImpl });
    await r2.handle({ session: "e".repeat(24), kind: "start", provider: "aws" });
    assert.deepEqual(iam.reports.at(-1), { session: "e".repeat(24), status: "failed", message: "AWS here signs in with IAM keys: run scripts/aws-auth.sh on the laptop" });
  });

  it("codex: reads the link and code through the colours", async () => {
    const { cfg, reports, procs, spawnImpl } = setup();
    const r = new SignInRunner(cfg, (u) => reports.push(u), { spawnImpl });
    await r.handle({ session: "f".repeat(24), kind: "start", provider: "paperclip-codex" });
    assert.deepEqual(procs[0].argv.slice(0, 7), ["docker", "compose", "exec", "-T", "-u", "node", "paperclip"]);
    procs[0].say("1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mQ7RT-9KXPL\x1b[0m\n");
    await tick();
    assert.deepEqual(reports.at(-1), { session: "f".repeat(24), status: "waiting", url: "https://auth.openai.com/codex/device", code: "Q7RT-9KXPL" });
  });

  it("claude: gives setup-token a terminal with the script syntax of the platform", async () => {
    const tty = "stty cols 4000 rows 50; exec claude setup-token";
    for (const [platform, script] of [["linux", ["script", "-qfec", tty, "/dev/null"]], ["darwin", ["script", "-q", "/dev/null", "sh", "-c", tty]]]) {
      const { cfg, reports, procs, spawnImpl } = setup();
      const r = new SignInRunner(cfg, (u) => reports.push(u), { spawnImpl, deps: { platform } });
      await r.handle({ session: "1".repeat(24), kind: "start", provider: "claude" });
      assert.deepEqual(procs[0].argv.slice(-script.length), script, platform);
    }
  });

  it("claude: shows the manual link, passes the code on, saves the token and never reports it", async () => {
    const { cfg, reports, procs, spawnImpl } = setup();
    const r = new SignInRunner(cfg, (u) => reports.push(u), { spawnImpl });
    await r.handle({ session: "0".repeat(24), kind: "start", provider: "claude" });
    const p = procs[0];
    assert.ok(p.argv.includes("script"));
    const manual = "https://claude.com/cai/oauth/authorize?code=true&client_id=c&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=s";
    p.say(`\x1b[2J Browser didn't open? Use the url below to sign in\r\n\x1b]8;id=1;${manual}\x07${manual.slice(0, 40)}\x1b]8;;\x07\r\n Paste code here if prompted > `);
    await tick();
    assert.deepEqual(reports.at(-1), { session: "0".repeat(24), status: "waiting", url: manual, prompt: { label: "The code Claude shows after you approve", secret: false } });
    await r.handle({ session: "0".repeat(24), kind: "input", text: "abc#def" });
    assert.deepEqual(p.stdin.written, ["abc#def"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(p.stdin.written, ["abc#def", "\r"]);
    p.say("\r\n Your OAuth token (valid for 1 year):\r\n\r\n sk-ant-oat01-" + "x".repeat(60) + "\r\n");
    await tick();
    await tick();
    assert.equal(readFileSync(cfg.claudeTokenFile, "utf8"), "sk-ant-oat01-" + "x".repeat(60));
    assert.equal(reports.at(-1).status, "done");
    assert.ok(p.killed);
    assert.ok(!JSON.stringify(reports).includes("sk-ant"), "the token never goes to the board");
  });

  it("claude: submits a full-length paste separately, and never submits after cancellation", async () => {
    const { cfg, reports, procs, spawnImpl } = setup();
    const r = new SignInRunner(cfg, (u) => reports.push(u), { spawnImpl });
    const code = "a".repeat(100) + "#" + "b".repeat(43);
    await r.handle({ session: "a".repeat(24), kind: "start", provider: "claude" });
    await r.handle({ session: "a".repeat(24), kind: "input", text: code });
    assert.deepEqual(procs[0].stdin.written, [code]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(procs[0].stdin.written, [code, "\r"]);
    await r.handle({ session: "a".repeat(24), kind: "cancel" });
    await r.handle({ session: "b".repeat(24), kind: "start", provider: "claude" });
    await r.handle({ session: "b".repeat(24), kind: "input", text: code });
    await r.handle({ session: "b".repeat(24), kind: "cancel" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(procs[1].stdin.written, [code]);
    assert.ok(!JSON.stringify(reports).includes(code));
  });

  it("claude: a clean exit without a token is not a completed sign-in", async () => {
    const { cfg, reports, procs, spawnImpl } = setup();
    const r = new SignInRunner(cfg, (u) => reports.push(u), { spawnImpl });
    await r.handle({ session: "c".repeat(24), kind: "start", provider: "claude" });
    procs[0].exit(0);
    await tick();
    assert.equal(reports.at(-1).status, "failed");
    assert.match(reports.at(-1).message, /without issuing a token/);
  });

  it("openrouter: asks for the key, checks it with OpenRouter, saves it, and lets a wrong one be retried", async () => {
    const { cfg, reports, spawnImpl } = setup();
    let accepted = false;
    const fetchImpl = async (_url, init) => new Response("{}", { status: (accepted = init.headers.authorization === "Bearer sk-or-good") ? 200 : 401 });
    const r = new SignInRunner(cfg, (u) => reports.push(u), { spawnImpl, deps: { fetchImpl } });
    await r.handle({ session: "1".repeat(24), kind: "start", provider: "openrouter" });
    assert.deepEqual(reports.at(-1), { session: "1".repeat(24), status: "waiting", prompt: { label: "OpenRouter API key", secret: true } });
    await r.handle({ session: "1".repeat(24), kind: "input", text: "sk-or-bad" });
    await tick();
    assert.deepEqual(reports.at(-1), { session: "1".repeat(24), status: "waiting", prompt: { label: "OpenRouter API key", secret: true }, message: "OpenRouter didn't accept that key." });
    await r.handle({ session: "1".repeat(24), kind: "input", text: "sk-or-good" });
    await tick();
    assert.ok(accepted);
    assert.equal(readFileSync(cfg.openrouterKeyFile, "utf8"), "sk-or-good");
    assert.equal(reports.at(-1).status, "done");
    assert.ok(!JSON.stringify(reports).includes("sk-or-"), "the key never goes back to the board");
  });

  it("codex: never touches the current sign-in until the new one has worked", async () => {
    const { dir, cfg, reports, procs, spawnImpl } = setup();
    const home = join(dir, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex/auth.json"), "current");
    const saved = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    try {
      const r = new SignInRunner(cfg, (u) => reports.push(u), { spawnImpl, deps: { home } });
      // Cancelled: the current sign-in stays.
      await r.handle({ session: "3".repeat(24), kind: "start", provider: "codex" });
      const first = procs[0].env.CODEX_HOME;
      assert.notEqual(first, join(home, ".codex"));
      assert.ok(procs[0].argv.includes('cli_auth_credentials_store="file"'));
      await r.handle({ session: "3".repeat(24), kind: "cancel" });
      assert.equal(readFileSync(join(home, ".codex/auth.json"), "utf8"), "current");
      // Finished: the new sign-in replaces it.
      await r.handle({ session: "4".repeat(24), kind: "start", provider: "codex" });
      writeFileSync(join(procs[1].env.CODEX_HOME, "auth.json"), "new");
      procs[1].exit(0);
      await tick();
      assert.equal(reports.at(-1).status, "done");
      assert.equal(readFileSync(join(home, ".codex/auth.json"), "utf8"), "new");
      assert.equal(statSync(join(home, ".codex/auth.json")).mode & 0o777, 0o600);
    } finally {
      if (saved !== undefined) process.env.CODEX_HOME = saved;
    }
  });

  it("paperclip-codex: signs in to a home of its own in the container and copies it over only on success", async () => {
    const { cfg, reports, procs, spawnImpl } = setup();
    const ran = [];
    const run = async (argv) => (ran.push(argv.at(-1)), { code: 0, stdout: "" });
    const r = new SignInRunner(cfg, (u) => reports.push(u), { spawnImpl, deps: { run } });
    await r.handle({ session: "5".repeat(24), kind: "start", provider: "paperclip-codex" });
    assert.match(procs[0].argv.at(-1), /CODEX_HOME=\/tmp\/pennyworth-codex-login exec codex/);
    procs[0].exit(0);
    await tick();
    assert.equal(reports.at(-1).status, "done");
    assert.ok(ran.some((c) => /cp \/tmp\/pennyworth-codex-login\/auth\.json \/paperclip\/\.codex\/auth\.json/.test(c)));
  });

  it("cancel stops the tool", async () => {
    const { cfg, reports, procs, spawnImpl } = setup();
    const r = new SignInRunner(cfg, (u) => reports.push(u), { spawnImpl });
    await r.handle({ session: "2".repeat(24), kind: "start", provider: "codex" });
    await r.handle({ session: "2".repeat(24), kind: "cancel" });
    assert.ok(procs[0].killed);
    assert.deepEqual(reports.at(-1), { session: "2".repeat(24), status: "cancelled", message: "Cancelled." });
  });
});
