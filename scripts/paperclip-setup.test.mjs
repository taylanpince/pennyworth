import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Exercise provisioning without connecting to or modifying a running instance.
const source = readFileSync(new URL("./paperclip-setup.mjs", import.meta.url), "utf8");
const body = source.slice(source.indexOf("function runnerAgentBody("), source.indexOf("function agentBody("));
const provision = runInNewContext(`${body}\nrunnerAgentBody`, {
  RUNNER_ADAPTERS: ["codex_local", "claude_local", "opencode_local"],
  ENGINES: ["codex", "claude", "openrouter"],
  fail: (message) => { throw new Error(message); },
  roleOf: () => "Build features", persona: () => ({}), engineCatalog: () => ({}),
});

test("role migration preserves instance model and effort defaults for the same engine", () => {
  const existing = { adapterType: "claude_local", adapterConfig: { model: "sonnet", effort: "high" } };
  const agent = { name: "Engineer", adapter: "claude_local" };
  const migrated = provision("engineer", agent, existing);
  assert.equal(migrated.metadata.role.model, "sonnet");
  assert.equal(migrated.metadata.role.effort, "high");
  const rerun = provision("engineer", agent, migrated);
  assert.equal(rerun.metadata.role.model, "sonnet");
  assert.equal(rerun.metadata.role.effort, "high");
  const configured = provision("engineer", { ...agent, model: "opus", reasoning_effort: "medium" }, migrated);
  assert.equal(configured.metadata.role.model, "opus");
  assert.equal(configured.metadata.role.effort, "medium");
  assert.equal(provision("engineer", { ...agent, effort: "low", reasoning_effort: "high" }, migrated).metadata.role.effort, "low");
  const changed = provision("engineer", { ...agent, engine: "codex" }, migrated);
  assert.equal(changed.metadata.role.model, undefined);
  assert.equal(changed.metadata.role.effort, undefined);
  assert.throws(() => provision("engineer", { ...agent, effort: "invalid" }, migrated), /unknown effort/);
});
