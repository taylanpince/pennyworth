// codex sandbox … -- … (around Claude Code) runs the command; codex exec --output-schema … answers
// the runner's short calls: the check on a GitHub write, and a comment while the task is busy.
// Anything else (a PR description, a branch name) fails, so the runner falls back.
import { readFileSync, writeFileSync } from "node:fs";
import { exec, log } from "./lib.mjs";

const args = process.argv.slice(2);
if (args[0] === "sandbox") exec(args.slice(args.indexOf("--") + 1));
const prompt = readFileSync(0, "utf8");
const answer = (json) => {
  writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(json));
  process.exit(0);
};
if (prompt.includes("<<<RECENT_COMMENTS_FROM_")) {
  // Allowed only when the user's recent words ask in so many words.
  const recent = /<<<RECENT_COMMENTS_FROM_\w+\n([\s\S]*?)\nRECENT_COMMENTS_FROM_/.exec(prompt)?.[1] ?? "";
  log("authorize", prompt);
  const yes = /go ahead|start merging|then merge|push it/i.test(recent);
  answer({ allowed: yes, reason: yes ? "asked" : "not asked" });
}
if (prompt.includes("<<<WORK")) {
  const comment = /<<<COMMENT\n([\s\S]*?)\nCOMMENT>>>/.exec(prompt)?.[1] ?? "";
  log("busy", comment);
  if (/\bstop\b|hold on/i.test(comment)) answer({ decision: "stop", answer: "" });
  if (/how's it going|is it done/i.test(comment)) answer({ decision: "answer", answer: "Still running: it's in the middle of the change." });
  answer({ decision: "later", answer: "" });
}
process.exit(1);
