// Claude Code with streamed input (--input-format stream-json --replay-user-messages): the first
// message is the runner's prompt. It does what $FAKE_STEP says (first line: what to do in acme/app;
// then any `pennyworth …` commands to run, as the agent would from its shell), and replies. Messages
// that arrive while it works are taken in and answered in the same turn; later ones get a turn each.
// It exits when stdin closes, like the real one.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { log } from "./lib.mjs";

const out = (event) => console.log(JSON.stringify(event));
const lines = [];
let closed = false;
let wake = () => {};
createInterface({ input: process.stdin })
  .on("line", (line) => {
    lines.push(JSON.parse(line).message.content);
    wake();
  })
  .on("close", () => {
    closed = true;
    wake();
  });
const next = () => (lines.length || closed ? Promise.resolve() : new Promise((r) => (wake = r)));
const take = () => {
  const text = lines.shift();
  out({ type: "user", isReplay: true, message: { role: "user", content: text } });
  return text;
};

await next();
const prompt = take();
log("claude", { argv: process.argv.slice(2), prompt });
out({ type: "system", subtype: "init", session_id: "session-1" });
// Usage like the real one's: each result carries the session's running totals (cost, modelUsage),
// which a resumed session carries on from (D-62). Every result adds $0.25 and fixed tokens.
const totalsFile = join(dirname(process.env.FAKE_LOG), "claude-totals.json");
let totals = process.argv.includes("--resume") && existsSync(totalsFile) ? JSON.parse(readFileSync(totalsFile, "utf8")) : 0;
const result = (fields) => {
  totals++;
  writeFileSync(totalsFile, JSON.stringify(totals));
  const model = { inputTokens: 10 * totals, outputTokens: 50 * totals, thinkingTokens: 5 * totals, cacheReadInputTokens: 1000 * totals, cacheCreationInputTokens: 100 * totals, costUSD: 0.25 * totals };
  out({ type: "result", subtype: "success", session_id: "session-1", num_turns: 3, total_cost_usd: 0.25 * totals, usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, iterations: [{ input_tokens: 2, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 }] }, modelUsage: { "claude-opus-5-5": model }, subagent_stats: { spawned: 0 }, ...fields });
};
out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }, { type: "tool_use", id: "tool-2", name: "mcp__grafana__query_loki_logs", input: {} }] } });

const repo = [join(process.cwd(), "app"), join(process.cwd(), "acme/app")].find((d) => existsSync(join(d, ".git")));
const git = (...args) => spawnSync("git", ["-C", repo, ...args], { stdio: "ignore" });
const [step, ...tools] = (existsSync(process.env.FAKE_STEP) ? readFileSync(process.env.FAKE_STEP, "utf8").trim() : "commit").split("\n");
if (step === "commit") {
  git("switch", "-qc", "fix/remove-telos", "origin/main");
  writeFileSync(join(repo, "chains.txt"), "polygon\n");
  git("add", "chains.txt");
  git("commit", "-qm", "fix: drop Telos");
} else if (step === "second") {
  git("switch", "-qc", "feat/second", "origin/main");
  writeFileSync(join(repo, "second.txt"), "second\n");
  git("add", "second.txt");
  git("commit", "-qm", "feat: second change");
} else if (step === "amend") {
  // Rewrites the pushed commit, as a rebase does.
  git("switch", "-q", "fix/remove-telos");
  writeFileSync(join(repo, "chains.txt"), `polygon\n# ${Date.now()}\n`);
  git("add", "chains.txt");
  git("commit", "-q", "--amend", "-m", "fix: drop Telos");
} else if (step === "inherit") {
  // Takes over a branch another task pushed (its PR) and rewrites it, as a rebase does (PEN-4089).
  git("fetch", "-q", "origin");
  git("switch", "-qc", "feat/inherited", "origin/feat/inherited");
  writeFileSync(join(repo, "inherited.txt"), `rebased\n# ${Date.now()}\n`);
  git("add", "inherited.txt");
  git("commit", "-q", "--amend", "-m", "feat: inherited");
} else if (step.startsWith("describe")) {
  // A PR description in the workspace, with Claude Code's own footer (and an internal name, for "describe-leak").
  mkdirSync(join(process.cwd(), ".pennyworth"), { recursive: true });
  writeFileSync(join(process.cwd(), ".pennyworth/pr-body.md"), `## Why\n\nTelos is gone.${step === "describe-leak" ? " Tracked in Paperclip." : ""}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n`);
} else if (step === "report") {
  // A report for Primer and a screenshot for the others to read (D-54).
  mkdirSync(join(process.cwd(), ".pennyworth/out"), { recursive: true });
  writeFileSync(join(process.cwd(), ".pennyworth/primer.md"), "# Wallet copy, mapped to the app\n\nWhere each string goes.\n");
  writeFileSync(join(process.cwd(), ".pennyworth/out/move-page.png"), Buffer.from("89504e470d0a1a0a", "hex"));
} else if (step === "slow") {
  await new Promise((r) => setTimeout(r, 6000));
}
for (const line of tools) {
  const [cmd, ...cmdArgs] = line.split(" ");
  const res = spawnSync(cmd, cmdArgs, { cwd: process.cwd(), encoding: "utf8" });
  log("tool", { line, code: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") });
}
// Messages that came in while it worked: taken in now, answered in this turn.
const during = [];
while (lines.length) during.push(take());
if (during.length) log("claude-mid-run", during);
const reply = step === "silent" ? "NO_REPLY" : "Checked every repository; nothing needed changing.";
result({ result: during.length ? `${reply}\n\nAlso, as you asked while I worked: ${during.join(" / ")}` : reply });
// Anything after this turn ended gets a turn of its own, until the runner closes the input.
for (;;) {
  await next();
  if (!lines.length && closed) break;
  const text = take();
  result({ result: `On your later note (${text}): done.` });
}
