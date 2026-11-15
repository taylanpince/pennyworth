import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { test } from "node:test";
import { buildCommand } from "../src/engines.mjs";
import { runAws } from "../src/aws.mjs";

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
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
