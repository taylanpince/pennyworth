// No GitHub API: every gh call fails (so PRs can't open), as it may on a bad day. Only an edit to
// an open PR's title and description goes through, logged with what it would have written, and a
// lookup of a branch's open PR answers from gh-prs.json next to the log (PRs the user opened).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./lib.mjs";

const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "edit") {
  log("gh", args);
  process.exit(0);
}
const lookup = args[0] === "api" && /^repos\/([^/]+\/[^/?]+)\/pulls\?head=([^&]+)&state=open$/.exec(args[1] ?? "");
const prs = join(dirname(process.env.FAKE_LOG), "gh-prs.json");
if (lookup && existsSync(prs)) {
  const url = JSON.parse(readFileSync(prs, "utf8"))[`${lookup[1]} ${decodeURIComponent(lookup[2])}`];
  process.stdout.write(JSON.stringify(url ? [{ html_url: url }] : []));
  process.exit(0);
}
process.exit(1);
