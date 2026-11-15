import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { test } from "node:test";
import { buildCommand, checkCodexPermissions, runAgent } from "../src/engines.mjs";
import { runAws } from "../src/aws.mjs";

test("Codex permission preflight fails closed and cleans up without exposing command output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-permission-check-"));
  const cfg = { devshells: { flake: "" }, sandbox: { credential_isolation: "permissions" } };
  try {
    for (const exec of [async () => ({ stdout: "" }), async () => { throw new Error("private output"); }]) {
      await assert.rejects(checkCodexPermissions({ cfg, worktree: dir, env: { HOME: dir }, exec }), (e) => /No agent was started/.test(e.message) && !e.message.includes("private output"));
      assert.deepEqual(readdirSync(dir), []);
    }
    mkdirSync(join(dir, ".codex"));
    writeFileSync(join(dir, ".codex/config.toml"), 'sandbox_mode = "workspace-write"\n');
    let ran = false;
    await assert.rejects(checkCodexPermissions({ cfg, worktree: dir, env: { HOME: dir }, exec: async () => { ran = true; return { stdout: "pennyworth-permissions-ok" }; } }), /legacy sandbox_mode/);
    assert.equal(ran, false);
    cfg.ghWrapperDir = dir;
    const job = { cfg, engine: { kind: "codex" }, shells: [], worktree: dir, prompt: "must not run", logPath: join(dir, "job.log"), env: { HOME: dir, CODEX_HOME: join(dir, ".codex") } };
    await assert.rejects(runAgent(job), /legacy sandbox_mode/);
    assert.equal(existsSync(job.logPath), false, "the model process was never started");
    const stopped = await runAgent({ ...job, cfg: { ...cfg, sandbox: {} }, signal: AbortSignal.abort() });
    assert.equal(stopped.cancelled, true);
    assert.equal(existsSync(job.logPath), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Opt-in host check: exercises the installed Codex and real kernel/AppArmor policy.
// Keep the fixture outside /tmp, which is intentionally writable inside jobs.
test("single sandbox starts, hides credentials and confines writes on this host", { skip: process.env.PENNYWORTH_TEST_SANDBOX !== "1" }, async () => {
  const dir = mkdtempSync(join(homedir(), ".pennyworth-sandbox-test-"));
  try {
    const work = join(dir, "work");
    const hidden = join(dir, "hidden");
    mkdirSync(work); mkdirSync(hidden);
    writeFileSync(join(hidden, "key"), "fake credential");
    writeFileSync(join(dir, "token"), "fake token");
    const cfg = { claudeTokenFile: join(dir, "token"), claudeConfigDir: join(dir, "claude"), aws: { hidden: [hidden] }, sandbox: { credential_isolation: "permissions" } };
    const { argv } = buildCommand({ cfg, engine: { kind: "claude" }, worktree: work });
    const probe = `import {readFileSync,writeFileSync} from 'node:fs';
      let blocked=0;
      try {readFileSync(${JSON.stringify(join(hidden, "key"))})} catch {blocked++}
      try {writeFileSync(${JSON.stringify(join(dir, "outside"))},'bad')} catch {blocked++}
      writeFileSync(${JSON.stringify(join(work, "allowed"))},'ok');
      if(blocked!==2)process.exit(1);`;
    writeFileSync(join(dir, "probe.mjs"), probe);
    const result = await runAws([...argv.slice(0, argv.indexOf("--") + 1), process.execPath, join(dir, "probe.mjs")], { cwd: work });
    assert.equal(result.code, 0, result.stderr);
    cfg.devshells = { flake: "" };
    await checkCodexPermissions({ cfg, worktree: work });
    const legacyHome = join(dir, "legacy-codex");
    mkdirSync(legacyHome);
    writeFileSync(join(legacyHome, "config.toml"), 'sandbox_mode = "workspace-write"\n');
    await assert.rejects(checkCodexPermissions({ cfg, worktree: work, env: { ...process.env, CODEX_HOME: legacyHome } }), /preflight failed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
