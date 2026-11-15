import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { awsSession, checkAwsCommand, profilesConfig, roleCredentials, runAwsWrite, showCommand } from "../src/aws.mjs";
import { describeAction } from "../src/authorize.mjs";
import { buildCommand } from "../src/engines.mjs";
import { observeSection } from "../src/prompt.mjs";
import { loadConfig } from "../src/config.mjs";

const accounts = [
  { name: "prod-api", id: "111111111111", region: "ca-central-1", readRole: "ReadOnlyAccess", writeRole: "AdministratorAccess" },
  { name: "prod-kms", id: "222222222222", region: "us-east-1", readRole: "ReadOnlyAccess" },
];

/** Pennyworth's AWS home, signed in (an SSO token in its cache) unless `signedIn: false`. */
function setup({ signedIn = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pw-aws-"));
  const home = join(dir, "aws-home");
  if (signedIn) {
    mkdirSync(join(home, ".aws/sso/cache"), { recursive: true });
    writeFileSync(join(home, ".aws/sso/cache/abc.json"), JSON.stringify({ startUrl: "https://d-1.awsapps.com/start", accessToken: "sso" }));
  }
  return { dir, aws: { home, sso: { startUrl: "https://d-1.awsapps.com/start", region: "ca-central-1" }, accounts, hidden: [home] } };
}

/** The aws CLI, faked: export-credentials answers per profile from `answers`; anything else is recorded. */
function fakeAws(answers = {}) {
  const calls = [];
  const exec = async (argv, opts) => {
    calls.push({ argv, env: opts.env, cwd: opts.cwd });
    const i = argv.indexOf("--profile");
    if (argv.includes("export-credentials")) {
      const a = answers[argv[i + 1]] ?? { key: argv[i + 1] };
      if (a.error) return { code: 255, stdout: "", stderr: `\n${a.error}\n` };
      return { code: 0, stdout: JSON.stringify({ Version: 1, AccessKeyId: `AKIA-${a.key}`, SecretAccessKey: `secret-${a.key}`, SessionToken: `session-${a.key}`, Expiration: "2026-11-10T21:00:00+00:00" }), stderr: "" };
    }
    return { code: 0, stdout: '{"service": {"status": "ACTIVE"}}', stderr: "" };
  };
  return { exec, calls };
}

describe("AWS for Engineer jobs (D-59)", () => {
  it("defaults to SSO and requires explicit IAM opt-in without write roles", () => {
    const dir = mkdtempSync(join(tmpdir(), "pw-aws-config-"));
    writeFileSync(join(dir, "system.yaml"), 'paperclip:\n  company_id: "00000000-0000-4000-8000-000000000001"\n');
    const old = process.env.PENNYWORTH_CONFIG_DIR;
    process.env.PENNYWORTH_CONFIG_DIR = dir;
    const configure = (aws) => {
      writeFileSync(join(dir, "runner.yaml"), JSON.stringify({ aws, devshells: {} }));
      return loadConfig().aws;
    };
    try {
      const account = { name: "test", id: "123456789012", region: "ca-central-1", read_role: "ReadOnlyAccess" };
      assert.equal(configure({}).auth, "sso");
      assert.equal(configure({ accounts: [account] }).accounts.length, 0);
      assert.equal(configure({ sso_start_url: "https://example.com", accounts: [account] }).accounts.length, 1);
      const iam = configure({ auth: "iam", accounts: [account] });
      assert.equal(iam.accounts[0].id, account.id);
      assert.ok(iam.hidden.includes(iam.home));
      assert.throws(() => configure({ auth: "typo" }), /aws.auth/);
      assert.throws(() => configure({ auth: "iam", accounts: [{ ...account, region: "" }] }), /require name/);
      assert.throws(() => configure({ auth: "iam", accounts: [{ ...account, write_role: "AdministratorAccess" }] }), /read-only/);
    } finally {
      if (old === undefined) delete process.env.PENNYWORTH_CONFIG_DIR;
      else process.env.PENNYWORTH_CONFIG_DIR = old;
    }
  });

  it("keeps IAM keys hidden, checks the user and account, and gives jobs temporary read credentials only", async () => {
    const { dir, aws } = setup({ signedIn: false });
    aws.auth = "iam";
    aws.accounts = [{ ...accounts[1] }];
    const account = aws.accounts[0];
    await assert.rejects(roleCredentials({ aws, account, kind: "read" }), (e) => e.state === "missing");
    mkdirSync(join(aws.home, ".aws"), { recursive: true });
    writeFileSync(join(aws.home, ".aws/credentials"), "[prod-kms.read]\naws_access_key_id = long-lived\naws_secret_access_key = private\n");
    const calls = [];
    let identity = { Account: account.id, Arn: `arn:aws:iam::${account.id}:user/reader` };
    const exec = async (argv, { env }) => {
      calls.push(argv);
      assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, join(aws.home, ".aws/credentials"));
      assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
      return { code: 0, stdout: JSON.stringify(argv.includes("get-caller-identity") ? identity : { Credentials: { AccessKeyId: "temporary", SecretAccessKey: "temporary-secret", SessionToken: "temporary-token", Expiration: new Date(Date.now() + 3600_000).toISOString() } }) };
    };
    const session = await awsSession({ aws, dir: join(dir, "job"), exec });
    try {
      assert.equal(session.state, "ok");
      assert.equal(session.accounts[0].writable, false);
      assert.deepEqual(session.writeRoles, []);
      assert.match(observeSection("Taylan", { aws: session }), /dedicated read-only IAM user/);
      const saved = readFileSync(session.env.AWS_SHARED_CREDENTIALS_FILE, "utf8");
      assert.match(saved, /aws_access_key_id = temporary/);
      assert.doesNotMatch(saved, /long-lived|private/);
      assert.equal(statSync(session.env.AWS_SHARED_CREDENTIALS_FILE).mode & 0o777, 0o600);
      assert.deepEqual(calls[1].slice(0, 5), ["aws", "sts", "get-session-token", "--duration-seconds", "3600"]);
      assert.doesNotMatch(readFileSync(join(aws.home, ".aws/config"), "utf8"), /sso|undefined/);
      await assert.rejects(roleCredentials({ aws, account, kind: "write", exec }), (e) => e.state === "refused");
      for (identity of [{ Account: "wrong", Arn: "arn:aws:iam::wrong:user/reader" }, { Account: account.id, Arn: `arn:aws:iam::${account.id}:root` }]) {
        await assert.rejects(roleCredentials({ aws, account, kind: "read", exec }), (e) => e.state === "refused");
      }
      await assert.rejects(roleCredentials({ aws, account, kind: "read", exec: async () => ({ code: 1, stderr: "private-key" }) }), (e) => e.state === "unavailable" && !e.message.includes("private-key"));
      await assert.rejects(roleCredentials({ aws, account, kind: "read", exec: async () => ({ code: 0, stdout: "private-key" }) }), /invalid response/);
    } finally { session.done(); }
    assert.ok(!existsSync(join(dir, "job")));
  });

  it("writes Pennyworth's profiles: one SSO session, a read and a write profile per account", () => {
    const { aws } = setup();
    const text = profilesConfig(aws);
    assert.match(text, /\[sso-session pennyworth\]\nsso_start_url = https:\/\/d-1\.awsapps\.com\/start\nsso_region = ca-central-1/);
    assert.match(text, /\[profile prod-api\.read\]\nsso_session = pennyworth\nsso_account_id = 111111111111\nsso_role_name = ReadOnlyAccess\nregion = ca-central-1/);
    assert.match(text, /\[profile prod-api\.write\][^[]*sso_role_name = AdministratorAccess/);
    assert.doesNotMatch(text, /prod-kms\.write/, "no write role, no write profile");
  });

  it("mints role credentials from the sign-in, and says why when it can't", async () => {
    const { aws } = setup();
    const { exec, calls } = fakeAws({ "prod-api.read": { key: "R" } });
    const c = await roleCredentials({ aws, account: accounts[0], kind: "read", exec });
    assert.equal(c.accessKeyId, "AKIA-R");
    assert.deepEqual(calls[0].argv, ["aws", "configure", "export-credentials", "--profile", "prod-api.read", "--format", "process"]);
    assert.equal(calls[0].env.HOME, aws.home, "Pennyworth's own home, never the user's ~/.aws");
    const expired = fakeAws({ "prod-api.read": { error: "Error when retrieving token from sso: Token has expired and refresh failed" } });
    await assert.rejects(roleCredentials({ aws, account: accounts[0], kind: "read", exec: expired.exec }), (e) => e.state === "expired" && /aws-auth\.sh/.test(e.message));
    const refused = fakeAws({ "prod-api.read": { error: "An error occurred (ForbiddenException) when calling the GetRoleCredentials operation: No access" } });
    await assert.rejects(roleCredentials({ aws, account: accounts[0], kind: "read", exec: refused.exec }), (e) => e.state === "refused" && /ReadOnlyAccess in prod-api/.test(e.message));
    await assert.rejects(roleCredentials({ aws, account: accounts[1], kind: "write", exec }), (e) => e.state === "refused");
    await assert.rejects(roleCredentials({ aws: setup({ signedIn: false }).aws, account: accounts[0], kind: "read", exec }), (e) => e.state === "missing");
  });

  it("gives a job read credentials per account in files of its own, and removes them afterwards", async () => {
    const { dir, aws } = setup();
    const { exec } = fakeAws({ "prod-api.read": { key: "R1" }, "prod-kms.read": { error: "ForbiddenException: No access" } });
    const s = await awsSession({ aws, dir: join(dir, "job"), exec });
    assert.equal(s.state, "ok");
    assert.deepEqual(s.accounts.map((a) => [a.name, a.writable]), [["prod-api", true]]);
    assert.match(s.unavailable[0].detail, /refused ReadOnlyAccess in prod-kms/);
    const creds = readFileSync(join(dir, "job/credentials"), "utf8");
    assert.match(creds, /\[default\]\naws_access_key_id = AKIA-R1/);
    assert.match(creds, /\[prod-api\]\naws_access_key_id = AKIA-R1/);
    assert.doesNotMatch(creds, /prod-kms/);
    assert.equal(statSync(join(dir, "job/credentials")).mode & 0o777, 0o600);
    assert.match(readFileSync(join(dir, "job/config"), "utf8"), /\[profile prod-api\]\nregion = ca-central-1\noutput = json\ncli_pager =/);
    // Files, not keys in variables: Codex drops variables named *KEY*, *SECRET* or *TOKEN*.
    assert.ok(Object.keys(s.env).every((k) => !/KEY|SECRET|TOKEN/.test(k)), Object.keys(s.env).join());
    assert.ok(!JSON.stringify(s.env).includes("AKIA"));
    s.done();
    assert.ok(!existsSync(join(dir, "job")));

    const ended = await awsSession({ aws, dir: join(dir, "job2"), exec: fakeAws({ "prod-api.read": { error: "Token has expired and refresh failed" }, "prod-kms.read": { error: "Token has expired and refresh failed" } }).exec });
    assert.equal(ended.state, "expired");
    assert.deepEqual(ended.env, {});
    ended.done();
    assert.equal((await awsSession({ aws: { ...aws, accounts: [] }, dir: join(dir, "job3"), exec })).state, "missing");
  });

  it("gives AWS to Claude Code and Codex only, and hides both AWS sign-ins from every engine", () => {
    const { dir, aws } = setup();
    mkdirSync(join(dir, "user-aws"));
    const c = { claudeTokenFile: join(dir, "claude"), claudeConfigDir: join(dir, "claude-home"), openrouterKeyFile: join(dir, "or"), gcp: { hidden: [] }, aws: { ...aws, hidden: [join(dir, "user-aws"), aws.home] }, sandbox: { extra_writable_roots: [] } };
    writeFileSync(c.claudeTokenFile, "tok");
    writeFileSync(c.openrouterKeyFile, "ork");
    const session = { env: { AWS_CONFIG_FILE: join(dir, "job/config"), AWS_SHARED_CREDENTIALS_FILE: join(dir, "job/credentials") } };
    for (const kind of ["codex", "claude", "openrouter"]) {
      const { argv, env } = buildCommand({ cfg: c, engine: { kind, model: "m" }, worktree: "/w", lastMessageFile: "/x", aws: session });
      assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, kind === "openrouter" ? undefined : session.env.AWS_SHARED_CREDENTIALS_FILE, kind);
      assert.deepEqual(argv.slice(0, 8), ["bwrap", "--dev-bind", "/", "/", "--tmpfs", join(dir, "user-aws"), "--tmpfs", aws.home], kind);
    }
  });

  it("optionally combines Claude/OpenRouter credential hiding and write confinement in one sandbox", () => {
    const { dir, aws } = setup();
    const cfg = { claudeTokenFile: join(dir, "claude"), claudeConfigDir: join(dir, "claude-home"), openrouterKeyFile: join(dir, "or"), aws, gcp: { hidden: [join(dir, "gcloud")] }, sandbox: { credential_isolation: "permissions", extra_writable_roots: [join(dir, "cache")] } };
    writeFileSync(cfg.claudeTokenFile, "tok");
    writeFileSync(cfg.openrouterKeyFile, "ork");
    for (const kind of ["claude", "openrouter"]) {
      const { argv } = buildCommand({ cfg, engine: { kind, model: "m" }, worktree: join(dir, "work") });
      assert.deepEqual(argv.slice(0, 4), ["codex", "sandbox", "-P", "pennyworth-job"]);
      assert.ok(!argv.includes("bwrap"));
      assert.ok(!argv.some((a) => a.startsWith("sandbox_mode=")), "legacy settings must not override the permissions profile");
      const profile = argv.find((a) => a.startsWith("permissions.pennyworth-job="));
      assert.ok(profile.includes(`${JSON.stringify(aws.home)}="deny"`));
      assert.ok(profile.includes(`${JSON.stringify(cfg.gcp.hidden[0])}="deny"`));
      assert.ok(profile.includes(`${JSON.stringify(join(dir, "work"))}="write"`));
      assert.ok(profile.includes(`${JSON.stringify(join(dir, "cache"))}="write"`));
      assert.ok(profile.includes('":root"="read"'));
      assert.ok(profile.includes('network={enabled=true}'));
    }
    assert.equal(buildCommand({ cfg, engine: { kind: "codex" }, worktree: "/w", lastMessageFile: "/x" }).argv[0], "bwrap", "Codex exec retains its existing sandbox path");
    assert.throws(() => buildCommand({ cfg, engine: { kind: "claude" }, worktree: join(aws.home, "workspace") }), /overlaps/);
  });

  it("refuses commands that hand out credentials or reach the sign-in, whatever the words", () => {
    for (const ok of [
      ["ecs", "update-service", "--cluster", "prod", "--service", "api", "--force-new-deployment"],
      ["ec2", "reboot-instances", "--instance-ids", "i-1"],
      ["autoscaling", "set-desired-capacity", "--auto-scaling-group-name", "g", "--desired-capacity", "3"],
      ["lambda", "update-function-configuration", "--function-name", "f", "--timeout", "30"],
      ["ssm", "send-command", "--document-name", "AWS-RunShellScript", "--targets", "Key=instanceids,Values=i-1"],
      ["s3", "cp", "./report.json", "s3://bucket/report.json"],
      ["secretsmanager", "rotate-secret", "--secret-id", "api"],
    ]) assert.equal(checkAwsCommand(ok), undefined, ok.join(" "));
    for (const [bad, why] of [
      [["secretsmanager", "get-secret-value", "--secret-id", "x"], /credentials, tokens or secret values/],
      [["iam", "create-access-key", "--user-name", "x"], /credentials/],
      [["ecr", "get-login-password"], /credentials/],
      [["eks", "get-token", "--cluster-name", "x"], /credentials/],
      [["kms", "decrypt", "--ciphertext-blob", "fileb://x"], /credentials/],
      [["s3", "presign", "s3://b/k"], /credentials/],
      [["ssm", "start-session", "--target", "i-1"], /session/],
      [["ecs", "execute-command", "--cluster", "c", "--task", "t", "--interactive", "--command", "sh"], /session/],
      [["iam", "create-login-profile", "--user-name", "x", "--password", "p"], /credentials/],
      [["ssm", "get-parameter", "--name", "/db/password", "--with-decryption"], /--with-decryption isn't allowed/],
      [["ecs", "update-service", "--profile", "other"], /--profile isn't allowed/],
      [["ecs", "update-service", "--endpoint-url=https://example.com"], /--endpoint-url isn't allowed/],
      [["sts", "assume-role", "--role-arn", "arn"], /sign-ins and credentials/],
      [["configure", "set", "x", "y"], /sign-ins and credentials/],
      [["--region", "us-east-1", "ecs", "update-service"], /service and the operation first/],
      [["ecs"], /service and the operation first/],
      [["ecs", "update-service", "help"], /help works without pennyworth/],
    ]) assert.match(checkAwsCommand(bad) ?? "", why, bad.join(" "));
    assert.equal(showCommand(["ecs", "update-service", "--cluster", "prod api"]), "aws ecs update-service --cluster 'prod api'");
  });

  it("runs a change with the write role, in an empty home with only the workspace, credentials in its environment", async () => {
    const { dir, aws } = setup();
    const { exec, calls } = fakeAws({ "prod-api.write": { key: "W" } });
    const cfg = { aws, devshells: { flake: "/flake", engine_shell: "llm" } };
    const workspace = join(dir, "ws");
    const res = await runAwsWrite({ cfg, account: accounts[0], args: ["ecs", "update-service", "--cluster", "prod", "--service", "api", "--force-new-deployment"], workspace, exec });
    assert.equal(res.code, 0);
    assert.equal(calls[0].argv[calls[0].argv.indexOf("--profile") + 1], "prod-api.write");
    const run = calls[1];
    assert.deepEqual(run.argv.slice(0, 4), ["nix", "develop", "/flake#llm", "--command"]);
    const bwrap = run.argv.slice(4, run.argv.indexOf("aws"));
    assert.deepEqual(bwrap, ["bwrap", "--dev-bind", "/", "/", "--tmpfs", homedir(), "--bind", workspace, workspace, "--tmpfs", "/tmp", "--chdir", workspace, "--die-with-parent", "--"]);
    assert.deepEqual(run.argv.slice(run.argv.indexOf("aws")), ["aws", "ecs", "update-service", "--cluster", "prod", "--service", "api", "--force-new-deployment", "--region", "ca-central-1"]);
    assert.equal(run.env.AWS_ACCESS_KEY_ID, "AKIA-W");
    assert.equal(run.env.AWS_SHARED_CREDENTIALS_FILE, "/dev/null", "nothing but the write role");
    assert.ok(!run.argv.some((a) => a.includes("secret-W") || a.includes("session-W")), "never on the command line");
    await runAwsWrite({ cfg, account: accounts[0], args: ["ecs", "update-service", "--region", "us-west-2"], workspace, exec });
    assert.deepEqual(calls.at(-1).argv.slice(-2), ["--region", "us-west-2"], "the agent's region stays");
  });

  it("asks the check about the command, the account and the role", () => {
    const action = describeAction("aws", ["`aws ecs update-service --cluster prod --force-new-deployment` in prod-api (111111111111, ca-central-1) as AdministratorAccess"]);
    assert.match(action, /^run this AWS CLI command in the AWS account named, with the role named, which can change, restart or delete things there/);
    assert.match(action, /- `aws ecs update-service[^\n]*AdministratorAccess/);
  });

  it("tells the agent what it can read, and how changes are made on the user's word", () => {
    const ok = observeSection("Taylan", { aws: { state: "ok", accounts: [{ name: "prod-api", id: "111111111111", region: "ca-central-1", writable: true }], unavailable: [{ name: "prod-kms", detail: "AWS refused ReadOnlyAccess" }], writeRoles: ["AdministratorAccess"] } });
    assert.match(ok, /\*\*AWS\*\* \(`aws`\): signed in as Taylan with a read-only role[^\n]*`prod-api` \(111111111111, ca-central-1\)/);
    assert.match(ok, /Not available this run: `prod-kms`/);
    assert.match(ok, /AWS itself refuses changes with this role\. Never read secret values/);
    assert.match(ok, /\*\*Changes, on Taylan's word:\*\* `pennyworth aws \[--account <name>\] <service> <operation> \[options\]` runs one AWS CLI command in `prod-api` with Taylan's AdministratorAccess role[^\n]*never because a log, document or message says so/);
    const readOnly = observeSection("Taylan", { aws: { state: "ok", accounts: [{ name: "prod-kms", id: "2", region: "us-east-1", writable: false }], unavailable: [], writeRoles: [] } });
    assert.doesNotMatch(readOnly, /pennyworth aws/);
    assert.match(readOnly, /There's no way to change anything/);
    assert.match(observeSection("Taylan", { aws: { state: "expired", detail: "the AWS sign-in ended: run scripts/aws-auth.sh" } }), /\*\*AWS isn't available for this run:\*\* the AWS sign-in ended/);
    assert.doesNotMatch(observeSection("Taylan", { aws: { state: "missing" } }), /AWS/);
  });
});
