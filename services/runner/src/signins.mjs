import { execFile, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { roleCredentials, writeProfiles } from "./aws.mjs";
import { REPO_ROOT } from "./config.mjs";
import { inDevshells } from "./engines.mjs";
import { accessToken } from "./gcp.mjs";

/**
 * Sign-ins on the laptop, started from the board's Settings page (D-66). Each driver runs the tool's
 * own browserless login (gcloud's verification code, AWS's and GitHub's and Codex's device codes,
 * Claude's pasted code) exactly as the terminal scripts do, into the same places. What goes back to
 * the board is picked out of the tool's output by pattern: an https link, a one-time code, and
 * whether it's waiting for something to be pasted. The rest of the output, tokens included, never
 * leaves this process and is never logged. What the user pastes goes to the tool's input once.
 */

// ANSI colours and cursor moves; an OSC 8 hyperlink keeps its target, so a link survives the TUI.
const plain = (s) =>
  s
    .replace(/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g, " $1 ")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n");

const lastMatch = (text, re) => {
  let m, last;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  while ((m = g.exec(text))) last = m;
  return last;
};

const writeSecret = (file, value) => {
  // In place (same inode): containers bind-mount some of these files.
  writeFileSync(file, value, { mode: 0o600 });
  chmodSync(file, 0o600);
};

const run = (argv, opts = {}) =>
  new Promise((resolve) =>
    execFile(argv[0], argv.slice(1), { timeout: 30_000, encoding: "utf8", ...opts }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout).trim(), stderr: String(stderr).trim() })),
  );

/** Stops a Codex device login left running in Paperclip's container (it has no pkill). */
/** Where Paperclip's Codex sign-in is made, inside the container, before it replaces the current one. */
const PAPERCLIP_LOGIN = "/tmp/pennyworth-codex-login";
// The pattern is assembled from pieces so this shell's own command line doesn't match it.
const STOP_PAPERCLIP_LOGIN = 'd=device; for p in /proc/[0-9]*; do case "$(tr "\\0" " " < $p/cmdline 2>/dev/null)" in *codex*login*--"$d"-auth*) kill "${p#/proc/}" 2>/dev/null;; esac; done; true';

/** The scopes gh's token has beyond its defaults, so a new sign-in keeps them (Alfred's project boards need `project`). */
export function ghExtraScopes(statusText) {
  const m = /Token scopes:\s*(.+)/.exec(statusText);
  if (!m) return [];
  const all = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  return all.filter((s) => !["repo", "read:org", "gist"].includes(s));
}

/**
 * The drivers. `command` is the process to run (none: the board's prompt is the whole sign-in);
 * `read` picks the link, code and prompt out of the output so far; `input` turns the user's answer
 * into what the tool reads; `finish` checks the result and returns the message for the board.
 */
export function drivers(cfg, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const exec = deps.run ?? run;
  const llm = (argv) => inDevshells(cfg.devshells.flake, [cfg.devshells.engine_shell], argv);
  let codexLogin;
  const gh = {
    async command() {
      const status = await exec(["gh", "auth", "status", "--hostname", "github.com"]);
      const extra = ghExtraScopes(`${status.stdout}\n${status.stderr}`);
      // No browser or clipboard here: the link and code go to Settings.
      return { argv: ["gh", "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", ...(extra.length ? ["--scopes", extra.join(",")] : [])], env: { BROWSER: "true", DISPLAY: "", WAYLAND_DISPLAY: "" }, enter: true };
    },
    read: (out) => ({ code: lastMatch(out, /one-time code[^A-Z0-9]*([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1], url: /https:\/\/github\.com\/login\/device/.test(out) ? "https://github.com/login/device" : undefined }),
    async finish() {
      const login = await exec(["gh", "api", "user", "--jq", ".login"]);
      if (login.code !== 0) throw new Error("gh still isn't signed in");
      await copyGhToken();
      return `Signed in as @${login.stdout}. Alfred's GitHub token was refreshed too.`;
    },
  };
  async function copyGhToken() {
    const token = await exec(["gh", "auth", "token"]);
    if (token.code !== 0 || !token.stdout) throw new Error("gh has no token");
    writeSecret(join(cfg.secretsDir, "github_token"), token.stdout);
  }
  return {
    gcloud: {
      command: () => ({
        argv: inDevshells(cfg.devshells.flake, [cfg.gcp.shell], ["gcloud", "auth", "application-default", "login", "--no-launch-browser", "--disable-quota-project"]),
        env: { CLOUDSDK_CONFIG: dirname(cfg.gcp.credentialsFile) },
      }),
      read: (out) => ({
        url: lastMatch(out, /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s"']+/)?.[0],
        prompt: /enter the verification code/i.test(out) ? { label: "The verification code Google shows after you approve", secret: false } : undefined,
      }),
      input: (text) => `${text.trim()}\n`,
      async finish() {
        const t = await accessToken(cfg.gcp.credentialsFile, fetchImpl);
        const info = await fetchImpl("https://oauth2.googleapis.com/tokeninfo", { method: "POST", body: new URLSearchParams({ access_token: t.token }) }).then((r) => r.json()).catch(() => ({}));
        return `Signed in${info.email ? ` as ${info.email}` : ""}. Google ends the session after 16 hours.`;
      },
    },
    aws: {
      command() {
        if (cfg.aws.auth === "iam") throw new Error("AWS here signs in with IAM keys: run scripts/aws-auth.sh on the laptop");
        if (!cfg.aws.sso?.startUrl || !cfg.aws.sso?.region) throw new Error("Set aws.sso_start_url and aws.sso_region in config/runner.yaml first");
        writeProfiles(cfg.aws);
        return {
          argv: llm(["aws", "sso", "login", "--sso-session", "pennyworth", "--no-browser", "--use-device-code"]),
          env: { HOME: cfg.aws.home, AWS_CONFIG_FILE: join(cfg.aws.home, ".aws/config") },
        };
      },
      read: (out) => ({
        url: lastMatch(out, /https:\/\/[^\s]+\/device\?user_code=[A-Z0-9-]+/)?.[0] ?? lastMatch(out, /https:\/\/[^\s]+\/device\b[^\s]*/)?.[0],
        code: lastMatch(out, /^\s*([A-Z0-9]{4}-[A-Z0-9]{4})\s*$/m)?.[1],
      }),
      async finish() {
        const accounts = (cfg.aws.accounts ?? []).filter((a) => a.readRole);
        if (!accounts.length) return "Signed in. List the accounts jobs should see under aws.accounts in config/runner.yaml.";
        const bad = [];
        for (const account of accounts) await (deps.aws ?? roleCredentials)({ aws: cfg.aws, account, kind: "read" }).catch((err) => bad.push(`${account.name}: ${String(err.message ?? err).slice(0, 120)}`));
        return bad.length ? `Signed in, but some read roles failed: ${bad.join("; ")}` : `Signed in. The read roles work in ${accounts.map((a) => a.name).join(", ")}.`;
      },
    },
    gh,
    github: {
      // Alfred's token is gh's: copy it when gh works, otherwise sign gh in first.
      async quick() {
        const login = await exec(["gh", "api", "user", "--jq", ".login"]);
        if (login.code !== 0) return undefined;
        await copyGhToken();
        return `Alfred's GitHub token was refreshed from gh (@${login.stdout}).`;
      },
      ...gh,
    },
    // `codex login` deletes the current sign-in as it starts (found 2026-11-16, when cancelled test sign-ins
    // logged out the laptop and every Paperclip agent). So it signs in to a fresh home, and the new
    // sign-in replaces the current one only once it has worked.
    codex: {
      command() {
        const home = mkdtempSync(join(tmpdir(), "pennyworth-codex-login-"));
        codexLogin = home;
        return { argv: llm(["codex", "-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"]), env: { CODEX_HOME: home }, cleanup: () => rmSync(home, { recursive: true, force: true }) };
      },
      read: (out) => ({ url: lastMatch(out, /https:\/\/auth\.openai\.com\/codex\/device[^\s]*/)?.[0], code: lastMatch(out, /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/)?.[1] }),
      async finish() {
        const made = join(codexLogin, "auth.json");
        if (!existsSync(made)) throw new Error("Codex didn't save a sign-in");
        const dir = process.env.CODEX_HOME ?? join(deps.home ?? homedir(), ".codex");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        copyFileSync(made, join(dir, "auth.json"));
        chmodSync(join(dir, "auth.json"), 0o600);
        return "Signed in. Codex jobs use it from their next run.";
      },
    },
    "paperclip-codex": {
      command: () => ({
        argv: ["docker", "compose", "exec", "-T", "-u", "node", "paperclip", "sh", "-c", `rm -rf ${PAPERCLIP_LOGIN} && mkdir -m 700 ${PAPERCLIP_LOGIN} && CODEX_HOME=${PAPERCLIP_LOGIN} exec codex -c 'cli_auth_credentials_store="file"' login --device-auth`],
        cwd: REPO_ROOT,
        // Stopping the docker client leaves the login running in the container: stop it there too.
        cleanup: () => void exec(["docker", "compose", "exec", "-T", "-u", "node", "paperclip", "sh", "-c", `${STOP_PAPERCLIP_LOGIN}; rm -rf ${PAPERCLIP_LOGIN}`], { cwd: REPO_ROOT }),
      }),
      read: (out) => ({ url: lastMatch(out, /https:\/\/auth\.openai\.com\/codex\/device[^\s]*/)?.[0], code: lastMatch(out, /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/)?.[1] }),
      async finish() {
        const r = await exec(["docker", "compose", "exec", "-T", "-u", "node", "paperclip", "sh", "-c", `test -s ${PAPERCLIP_LOGIN}/auth.json && cp ${PAPERCLIP_LOGIN}/auth.json /paperclip/.codex/auth.json && chmod 600 /paperclip/.codex/auth.json`], { cwd: REPO_ROOT });
        if (r.code !== 0) throw new Error("Codex didn't save a sign-in in Paperclip");
        return "Signed in. Paperclip's agents use it from their next run.";
      },
    },
    claude: {
      command() {
        // setup-token is a TUI: give it a terminal (wide, so the link isn't wrapped) and a config dir of its own.
        const home = mkdtempSync(join(tmpdir(), "pennyworth-claude-signin-"));
        const tty = "stty cols 4000 rows 50; exec claude setup-token";
        // macOS ships BSD script: file first, then the command.
        const script = (deps.platform ?? process.platform) === "darwin" ? ["script", "-q", "/dev/null", "sh", "-c", tty] : ["script", "-qfec", tty, "/dev/null"];
        return {
          argv: llm(script),
          env: { CLAUDE_CONFIG_DIR: home, BROWSER: "true" },
          cleanup: () => rmSync(home, { recursive: true, force: true }),
        };
      },
      read(out) {
        const token = lastMatch(out, /sk-ant-oat01-[A-Za-z0-9_-]{20,}/)?.[0];
        if (token) return { token };
        return {
          url: lastMatch(out, /https:\/\/claude\.(?:com|ai)\/[^\s"'\x07\x1b]*oauth\/authorize\?[^\s"'\x07\x1b]*redirect_uri=https%3A%2F%2Fplatform\.claude\.com[^\s"'\x07\x1b]*/)?.[0],
          prompt: /paste\s*code/i.test(out) ? { label: "The code Claude shows after you approve", secret: false } : undefined,
          error: /invalid code|oauth error|failed to exchange/i.test(out) ? "Claude didn't accept the code. Start again." : undefined,
        };
      },
      input: (text) => `${text.trim()}\r`,
      async onToken(token) {
        writeSecret(cfg.claudeTokenFile, token);
        return "Saved. Claude jobs use it from their next run (it lasts a year).";
      },
    },
    openrouter: {
      prompt: { label: "OpenRouter API key", secret: true },
      async onInput(text) {
        const key = text.trim();
        const res = await fetchImpl("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(res.status === 401 ? "OpenRouter didn't accept that key." : `OpenRouter answered ${res.status}.`);
        writeSecret(cfg.openrouterKeyFile, key);
        return "Saved. OpenRouter jobs use it from their next run.";
      },
    },
  };
}

/**
 * The sessions in progress, one per provider. `report` sends an update to the board (the board
 * shows it); nothing a tool prints is reported but the fields `read` picked out.
 */
export class SignInRunner {
  constructor(cfg, report, { log = () => {}, deps = {}, spawnImpl = spawn, timeoutMs = 16 * 60_000 } = {}) {
    this.cfg = cfg;
    this.report = report;
    this.log = log;
    this.drivers = drivers(cfg, deps);
    this.spawn = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.sessions = new Map();
  }

  async handle(c) {
    if (c.kind === "start") return this.start(c.session, c.provider);
    const s = this.sessions.get(c.session);
    if (!s) return;
    if (c.kind === "cancel") return this.stop(s, "cancelled", "Cancelled.");
    if (c.kind === "input") return this.input(s, c.text);
  }

  async start(id, provider) {
    const d = this.drivers[provider];
    if (!d) return this.report({ session: id, status: "failed", message: `Pennyworth can't sign in to ${provider} from the board yet.` });
    for (const other of this.sessions.values()) if (other.provider === provider) this.stop(other, "cancelled", "Replaced by a new sign-in.");
    const s = { id, provider, d, out: "", sent: "", done: false };
    this.sessions.set(id, s);
    this.log("sign-in started", { provider });
    try {
      if (d.quick) {
        const msg = await d.quick();
        if (msg) return this.stop(s, "done", msg);
      }
      if (d.prompt) return this.send(s, { status: "waiting", prompt: d.prompt, message: undefined });
      const c = await d.command();
      s.cleanup = c.cleanup;
      const child = this.spawn(c.argv[0], c.argv.slice(1), { cwd: c.cwd ?? REPO_ROOT, env: { ...process.env, ...c.env }, stdio: ["pipe", "pipe", "pipe"] });
      s.child = child;
      s.timer = setTimeout(() => this.stop(s, "failed", "The sign-in took too long. Start again."), this.timeoutMs);
      s.timer.unref?.();
      const onData = (chunk) => {
        s.out = (s.out + plain(String(chunk))).slice(-64_000);
        this.read(s, c);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (err) => this.stop(s, "failed", `Couldn't start the sign-in: ${String(err.message).slice(0, 200)}`));
      child.on("close", (code) => void this.closed(s, code));
      this.send(s, { status: "starting", message: "Starting the sign-in…" });
    } catch (err) {
      this.stop(s, "failed", String(err.message ?? err).slice(0, 300));
    }
  }

  read(s, c) {
    if (s.done) return;
    const r = s.d.read(s.out);
    if (r.token) {
      // Claude prints the token once: save it, and stop the tool before anything else is read.
      s.child?.kill("SIGTERM");
      return void s.d.onToken(r.token).then((msg) => this.stop(s, "done", msg), (err) => this.stop(s, "failed", String(err.message ?? err).slice(0, 300)));
    }
    if (r.error) return this.stop(s, "failed", r.error);
    if (c.enter && r.code && !s.entered) {
      s.entered = true;
      s.child.stdin.write("\n");
    }
    if (r.url || r.code || r.prompt) this.send(s, { status: "waiting", url: r.url, code: r.code, prompt: s.answered ? undefined : r.prompt, message: s.answered ? "Checking…" : undefined });
  }

  async input(s, text) {
    if (s.done) return;
    if (s.d.onInput) {
      this.send(s, { status: "waiting", message: "Checking…" });
      return s.d.onInput(text).then((msg) => this.stop(s, "done", msg), (err) => this.send(s, { status: "waiting", prompt: s.d.prompt, message: String(err.message ?? err).slice(0, 300) }));
    }
    if (!s.child || !s.d.input) return;
    s.answered = true;
    s.child.stdin.write(s.d.input(text));
    this.send(s, { status: "waiting", url: undefined, code: undefined, prompt: undefined, message: "Checking…" });
  }

  async closed(s, code) {
    if (s.done) return;
    if (code !== 0) return this.stop(s, "failed", `The sign-in didn't finish (${s.provider} exited with ${code}). Start again.`);
    try {
      this.stop(s, "done", s.d.finish ? await s.d.finish() : "Signed in.");
    } catch (err) {
      this.stop(s, "failed", String(err.message ?? err).slice(0, 300));
    }
  }

  send(s, update) {
    const u = Object.fromEntries(Object.entries({ session: s.id, ...update }).filter(([, v]) => v !== undefined));
    const key = JSON.stringify(u);
    if (key === s.sent) return;
    s.sent = key;
    this.report(u);
  }

  stop(s, status, message) {
    if (s.done) return;
    s.done = true;
    clearTimeout(s.timer);
    if (s.child && s.child.exitCode === null) s.child.kill("SIGTERM");
    try {
      s.cleanup?.();
    } catch {}
    s.out = "";
    this.sessions.delete(s.id);
    this.log("sign-in ended", { provider: s.provider, status });
    this.report({ session: s.id, status, message });
  }
}

export const _test = { plain };
