// Claude Code with streamed input (--input-format stream-json --replay-user-messages): the first
// message is the runner's prompt. It does what $FAKE_STEP says (first line: what to do in acme/app;
// then any `pennyworth …` commands to run, as the agent would from its shell), and replies. Messages
// that arrive while it works are taken in and answered in the same turn; later ones get a turn each.
// It exits when stdin closes, like the real one.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
out({ type: "result", subtype: "success", result: during.length ? `${reply}\n\nAlso, as you asked while I worked: ${during.join(" / ")}` : reply });
// Anything after this turn ended gets a turn of its own, until the runner closes the input.
for (;;) {
  await next();
  if (!lines.length && closed) break;
  const text = take();
  out({ type: "result", subtype: "success", result: `On your later note (${text}): done.` });
}
