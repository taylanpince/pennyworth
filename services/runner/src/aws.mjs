import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inDevshells } from "./engines.mjs";

/**
 * AWS for Engineer jobs (D-59). Pennyworth signs in to IAM Identity Center on its own
 * (scripts/aws-auth.sh), in its own home (`cfg.aws.home`: the CLI keeps SSO tokens under
 * ~/.aws/sso/cache, with no setting to move them), hidden from jobs like the gcloud sign-ins. A job
 * gets one-hour credentials for each account's read-only role, refreshed while it runs, so AWS itself
 * refuses its writes. A change goes through `pennyworth aws`: the runner runs that one command with
 * the account's write role, once the user's words ask for it (src/authorize.mjs), and the job never
 * holds those credentials.
 */
export class AwsAuthError extends Error {
  constructor(message, state = "expired") {
    super(message);
    this.state = state;
  }
}

export const SSO_SESSION = "pennyworth";
const profile = (account, kind) => `${account.name}.${kind}`;

/** Pennyworth's ~/.aws/config: its SSO session, and a read and a write profile per account. */
export function profilesConfig(aws) {
  const lines = ["# Written by Pennyworth's runner from config/runner.yaml (aws:); edits here are replaced.", `[sso-session ${SSO_SESSION}]`, `sso_start_url = ${aws.sso.startUrl}`, `sso_region = ${aws.sso.region}`, "sso_registration_scopes = sso:account:access", ""];
  for (const a of aws.accounts) {
    for (const kind of ["read", "write"]) {
      const role = kind === "read" ? a.readRole : a.writeRole;
      if (role) lines.push(`[profile ${profile(a, kind)}]`, `sso_session = ${SSO_SESSION}`, `sso_account_id = ${a.id}`, `sso_role_name = ${role}`, `region = ${a.region}`, "");
    }
  }
  return lines.join("\n");
}

export function writeProfiles(aws) {
  mkdirSync(join(aws.home, ".aws"), { recursive: true, mode: 0o700 });
  writeFileSync(join(aws.home, ".aws/config"), profilesConfig(aws), { mode: 0o600 });
}

/** The aws CLI's answer: { code, stdout, stderr }, never a rejection. */
export function runAws(argv, { env, cwd, timeout = 60_000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { env, cwd, timeout, maxBuffer, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: stdout ?? "", stderr: stderr || (err && typeof err.code !== "number" ? String(err.message) : "") });
    });
  });
}

const signedIn = (home) => existsSync(join(home, ".aws/sso/cache")) && readdirSync(join(home, ".aws/sso/cache")).some((f) => f.endsWith(".json"));

/**
 * One-hour credentials for an account's read or write role, from Pennyworth's sign-in:
 * { accessKeyId, secretAccessKey, sessionToken, expiresAt }.
 */
export async function roleCredentials({ aws, account, kind, exec = runAws }) {
  const role = kind === "read" ? account.readRole : account.writeRole;
  if (!role) throw new AwsAuthError(`${account.name} has no ${kind} role set in config/runner.yaml`, "refused");
  if (!signedIn(aws.home)) throw new AwsAuthError("AWS isn't signed in for Pennyworth (run scripts/aws-auth.sh)", "missing");
  writeProfiles(aws);
  const env = { PATH: process.env.PATH, HOME: aws.home, AWS_CONFIG_FILE: join(aws.home, ".aws/config"), AWS_SHARED_CREDENTIALS_FILE: "/dev/null", AWS_EC2_METADATA_DISABLED: "true" };
  const res = await exec(["aws", "configure", "export-credentials", "--profile", profile(account, kind), "--format", "process"], { env, timeout: 30_000 });
  if (res.code === 0) {
    const c = JSON.parse(res.stdout);
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiresAt: Date.parse(c.Expiration) || Date.now() + 3600_000 };
  }
  const err = res.stderr.trim().split("\n").at(-1)?.slice(0, 300) ?? "";
  if (/expired|SSO Token|refresh|reauthenticate|sso login|UnauthorizedException/i.test(err)) throw new AwsAuthError("the AWS sign-in ended: run scripts/aws-auth.sh");
  if (/ForbiddenException|No access|not authorized|AccessDenied/i.test(err)) throw new AwsAuthError(`AWS refused ${role} in ${account.name} (${account.id}): is that role assigned in Identity Center?`, "refused");
  if (/Could not connect|EndpointConnectionError|timed out|ENOTFOUND|ETIMEDOUT/i.test(err)) throw new AwsAuthError(`AWS couldn't be reached (${err})`, "unavailable");
  throw new AwsAuthError(`AWS refused the sign-in for ${account.name} (${err || `exit ${res.code}`}): run scripts/aws-auth.sh`);
}

const credentialsBlock = (name, c) => [`[${name}]`, `aws_access_key_id = ${c.accessKeyId}`, `aws_secret_access_key = ${c.secretAccessKey}`, `aws_session_token = ${c.sessionToken}`, ""];
const configBlock = (header, a) => [header, `region = ${a.region}`, "output = json", "cli_pager =", ""];

/**
 * AWS for one job: a config and credentials file of its own, with a profile per account its read role
 * reached (`default` is the first), kept fresh while the job runs. Files rather than AWS_* variables:
 * Codex drops variables named *KEY*, *SECRET* and *TOKEN* from its tool calls. `state` is ok (at least
 * one account), missing (not set up or never signed in), expired, refused or unavailable; the job runs
 * either way, and the prompt says what it has. `done()` stops the refresh and removes the credentials.
 */
export async function awsSession({ aws, dir, log = () => {}, exec = runAws, refreshMinutes = 40 }) {
  const config = join(dir, "config");
  const credentials = join(dir, "credentials");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const readable = aws.accounts.filter((a) => a.readRole);
  const mint = async () => Promise.all(readable.map((a) => roleCredentials({ aws, account: a, kind: "read", exec }).then((c) => ({ a, c }), (err) => ({ a, err }))));
  const write = (results) => {
    const ok = results.filter((r) => r.c);
    if (!ok.length) return;
    const tmp = `${credentials}.tmp`;
    writeFileSync(tmp, [...credentialsBlock("default", ok[0].c), ...ok.flatMap((r) => credentialsBlock(r.a.name, r.c))].join("\n"), { mode: 0o600 });
    renameSync(tmp, credentials);
    writeFileSync(config, [...configBlock("[default]", ok[0].a), ...ok.flatMap((r) => configBlock(`[profile ${r.a.name}]`, r.a))].join("\n"), { mode: 0o600 });
  };
  let results = [];
  try {
    results = await mint();
  } catch (err) {
    if (!(err instanceof AwsAuthError)) throw err;
  }
  for (const r of results) if (r.err && !(r.err instanceof AwsAuthError)) throw r.err;
  write(results);
  const ok = results.filter((r) => r.c);
  const failed = results.filter((r) => r.err);
  const state = !readable.length ? "missing" : ok.length ? "ok" : failed[0].err.state;
  const timer =
    ok.length
      ? setInterval(() => {
          mint().then(
            (again) => (write(again.filter((r) => r.c && ok.some((o) => o.a === r.a))), again.filter((r) => r.err).forEach((r) => log("aws credentials refresh failed", { account: r.a.name, err: String(r.err.message).slice(0, 200) }))),
            (err) => log("aws credentials refresh failed", { err: String(err.message ?? err).slice(0, 200) }),
          );
        }, refreshMinutes * 60_000)
      : undefined;
  timer?.unref();
  return {
    state,
    detail: ok.length ? undefined : failed[0]?.err.message,
    accounts: ok.map((r) => ({ name: r.a.name, id: r.a.id, region: r.a.region, writable: Boolean(r.a.writeRole) })),
    unavailable: ok.length ? failed.map((r) => ({ name: r.a.name, detail: r.err.message })) : [],
    writeRoles: [...new Set(ok.filter((r) => r.a.writeRole).map((r) => r.a.writeRole))],
    env: ok.length ? { AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: credentials, AWS_EC2_METADATA_DISABLED: "true", AWS_PAGER: "" } : {},
    root: dir,
    done() {
      if (timer) clearInterval(timer);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// What `pennyworth aws` never runs, whatever the user's words. Its output goes back to the agent (and
// the command onto the task), so nothing that hands out credentials, tokens or secret values, opens a
// shell or a session, lets someone in, or reaches Pennyworth's own sign-in.
const REFUSED_SERVICES = new Set(["configure", "sso", "sso-oidc", "login", "logout", "sts", "signin", "history", "cli-dev", "cloudshell", "ec2-instance-connect"]);
const CREDENTIAL_OPERATION = /(^|-)(credentials?|tokens?|passwords?|secret-values?|access-keys?|access-details|login|presign|decrypt|data-key|session|sessions|execute-command|auth|ssh|connect)(-|$)/;
const REFUSED_OPTIONS = ["--profile", "--endpoint-url", "--no-verify-ssl", "--ca-bundle", "--no-sign-request", "--with-decryption", "--debug"];

/** Why `pennyworth aws <args>` can't run this, or undefined. `args` start with the service and the operation. */
export function checkAwsCommand(args) {
  if (!Array.isArray(args) || args.length < 2 || args.some((a) => typeof a !== "string")) return "give the service and the operation first: pennyworth aws [--account <name>] <service> <operation> [options]";
  const [service, operation] = args;
  if (service.startsWith("-") || operation.startsWith("-")) return "give the service and the operation first, options after them: pennyworth aws [--account <name>] <service> <operation> [options]";
  if (args.includes("help")) return "aws help works without pennyworth: run `aws <service> <operation> help` yourself";
  const option = args.find((a) => REFUSED_OPTIONS.includes(a.split("=")[0]));
  if (option) return `${option.split("=")[0]} isn't allowed: the account and its credentials are the runner's to pick`;
  if (REFUSED_SERVICES.has(service)) return `aws ${service} isn't run for agents: it handles sign-ins and credentials`;
  if (CREDENTIAL_OPERATION.test(operation)) return `aws ${service} ${operation} isn't run for agents: it hands out credentials, tokens or secret values, or opens a session. Ask the user to run it themselves`;
  return undefined;
}

const quoteArg = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
export const showCommand = (args) => `aws ${args.map(quoteArg).join(" ")}`;

/**
 * Run one checked command with an account's write role: under bwrap with an empty home (only the
 * workspace bound back in) and an empty /tmp, so files it reads or writes are the workspace's, and
 * nothing of the user's or Pennyworth's is in reach. The credentials go in its environment only.
 */
export async function runAwsWrite({ cfg, account, args, workspace, exec = runAws, timeout = 15 * 60_000 }) {
  const c = await roleCredentials({ aws: cfg.aws, account, kind: "write", exec });
  const home = homedir();
  const withRegion = args.some((a) => a === "--region" || a.startsWith("--region=")) ? args : [...args, "--region", account.region];
  const argv = inDevshells(cfg.devshells.flake, [cfg.devshells.engine_shell], [
    "bwrap", "--dev-bind", "/", "/", "--tmpfs", home, "--bind", workspace, workspace, "--tmpfs", "/tmp", "--chdir", workspace, "--die-with-parent", "--",
    "aws", ...withRegion,
  ]);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AWS_"))),
    HOME: home,
    AWS_ACCESS_KEY_ID: c.accessKeyId,
    AWS_SECRET_ACCESS_KEY: c.secretAccessKey,
    AWS_SESSION_TOKEN: c.sessionToken,
    AWS_CONFIG_FILE: "/dev/null",
    AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_PAGER: "",
  };
  return exec(argv, { env, cwd: workspace, timeout });
}

/**
 * The accounts and roles Pennyworth's sign-in can reach, from the access portal's API (for
 * scripts/aws-auth.sh): [{ id, name, roles: [...] }].
 */
export async function assignments(aws, fetchImpl = fetch) {
  const dir = join(aws.home, ".aws/sso/cache");
  const cached = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => { try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return {}; } })
    : [];
  const token = cached.find((t) => t.accessToken && t.startUrl === aws.sso.startUrl)?.accessToken;
  if (!token) throw new AwsAuthError("AWS isn't signed in for Pennyworth (run scripts/aws-auth.sh)", "missing");
  const base = `https://portal.sso.${aws.sso.region}.amazonaws.com`;
  const get = async (path) => {
    const res = await fetchImpl(`${base}${path}`, { headers: { "x-amz-sso_bearer_token": token }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new AwsAuthError(`the AWS access portal answered ${res.status}`, res.status === 401 ? "expired" : "unavailable");
    return res.json();
  };
  const all = async (path, key) => {
    const out = [];
    let next;
    do {
      const page = await get(`${path}${path.includes("?") ? "&" : "?"}max_result=100${next ? `&next_token=${encodeURIComponent(next)}` : ""}`);
      out.push(...(page[key] ?? []));
      next = page.nextToken;
    } while (next);
    return out;
  };
  const accounts = await all("/assignment/accounts", "accountList");
  return Promise.all(accounts.map(async (a) => ({ id: a.accountId, name: a.accountName, roles: (await all(`/assignment/roles?account_id=${a.accountId}`, "roleList")).map((r) => r.roleName).sort() })));
}
