// Claude Code: does what $FAKE_STEP says (first line: what to do in acme/app; then any `pennyworth …`
// commands to run, as the agent would from its shell), and replies.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { log } from "./lib.mjs";

log("claude", { argv: process.argv.slice(2), prompt: readFileSync(0, "utf8") });
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
} else if (step === "slow") {
  spawnSync("sleep", ["6"]);
}
for (const line of tools) {
  const [cmd, ...cmdArgs] = line.split(" ");
  const out = spawnSync(cmd, cmdArgs, { cwd: process.cwd(), encoding: "utf8" });
  log("tool", { line, code: out.status, out: (out.stdout ?? "") + (out.stderr ?? "") });
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" }));
console.log(JSON.stringify({ type: "result", result: step === "silent" ? "NO_REPLY" : "Checked every repository; nothing needed changing." }));
