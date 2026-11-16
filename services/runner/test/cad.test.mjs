import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCadRole } from "../src/cad.mjs";
import { buildCommand, privateReads, runAgent } from "../src/engines.mjs";
import { outputs, shareOutputs } from "../src/files.mjs";
import { firstPrompt, followUpPrompt } from "../src/prompt.mjs";

test("CAD follows role metadata, not the persona or selected engine", () => {
  assert.equal(isCadRole({ metadata: { runnerEngine: true, role: { workflow: "cad", engine: "claude" } } }), true);
  assert.equal(isCadRole({ metadata: { runnerEngine: true, persona: { name: "Charles" } } }), false);
});

test("CAD commands omit private MCP and cloud sessions", () => {
  const cfg = { localCad: true, sandbox: { credential_isolation: "permissions" }, primerTokenFile: "/must-not-read", slackTokenFile: "/must-not-read" };
  const { argv, env } = buildCommand({ cfg, engine: { kind: "codex" }, worktree: "/tmp/work", lastMessageFile: "/tmp/reply", gcp: { env: { CLOUDSDK_CONFIG: "secret" } }, aws: { env: { AWS_SHARED_CREDENTIALS_FILE: "secret" } } });
  assert.deepEqual(env, {});
  assert.deepEqual(privateReads(cfg), []);
  assert.ok(!argv.some((x) => x.includes("mcp_servers.")), "omitted servers must not become invalid transport-less config entries");
});

test("disabling Primer applies to ordinary runner roles and removes its prompt tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "primer-disabled-"));
  try {
    const token = join(dir, "token");
    writeFileSync(token, "fixture");
    const cfg = { primerEnabled: false, primerTokenFile: token, primerMcpUrl: "http://localhost:3123/mcp/read", sandbox: { credential_isolation: "permissions" } };
    const command = buildCommand({ cfg, engine: { kind: "codex" }, worktree: dir, lastMessageFile: join(dir, "reply") });
    assert.equal(command.env.PRIMER_MCP_TOKEN, undefined);
    assert.ok(!command.argv.some(x => x.includes("mcp_servers.primer")));
    const base = { user: "User", task: { identifier: "T-1", title: "Design", description: "" }, workspace: dir, repos: [], shells: [], instructions: "Build this", primerEnabled: false, primer: { url: "https://example.invalid/d/1" } };
    for (const prompt of [firstPrompt(base), followUpPrompt(base)]) {
      assert.doesNotMatch(prompt, /primer_resolve_url|primer_get_document|pennyworth primer|## Primer/);
      assert.match(prompt, /Primer is disabled here/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("earlier revisions do not consume the per-run attachment budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "cad-revisions-"));
  try {
    const out = join(root, ".pennyworth/out");
    mkdirSync(out, { recursive: true });
    for (let i = 0; i < 25; i++) writeFileSync(join(out, `part-${String(i).padStart(3, "0")}.step`), `revision ${i}`);
    const pc = { addAttachment: async (_id, name) => ({ id: name }) };
    const first = await shareOutputs(pc, { id: "task" }, outputs(root));
    assert.equal(first.attached.length, 20);
    const second = await shareOutputs(pc, { id: "task" }, outputs(root), first.shared);
    assert.equal(second.attached.length, 5);
    assert.equal(Object.keys(second.shared).length, 25);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CAD runs remove inherited service credentials while preserving the CAD tool paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cad-env-"));
  try {
    const keys = ["AWS_ACCESS_KEY_ID", "AWS_SHARED_CREDENTIALS_FILE", "CLOUDSDK_CONFIG", "GOOGLE_APPLICATION_CREDENTIALS", "PRIMER_MCP_TOKEN", "SLACK_MCP_TOKEN"];
    writeFileSync(join(dir, "codex"), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({present:${JSON.stringify(keys)}.filter(k=>k in process.env),python:process.env.CAD_PYTHON}));`, { mode: 0o755 });
    const result = await runAgent({ cfg: { localCad: true, devshells: { flake: "" }, ghWrapperDir: dir }, engine: { kind: "codex" }, shells: [], worktree: dir, prompt: "test", logPath: join(dir, "job.log"), env: { NODE_TEST_CONTEXT: undefined, PATH: dir, CAD_PYTHON: "/cad/python", ...Object.fromEntries(keys.map(k => [k, "fixture"])) } });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.lastMessage), { present: [], python: "/cad/python" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
