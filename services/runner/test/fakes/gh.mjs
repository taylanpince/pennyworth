// No GitHub API: every gh call fails, as it may on a bad day. Only an edit to an open PR's title and
// description goes through, logged with what it would have written; a lookup of a branch's open PR
// answers from gh-prs.json next to the log (PRs the user opened); and a draft PR opens, into that file,
// for a branch named in gh-open.json (a list of "<repo> <branch>"), so other PRs still fail to open.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./lib.mjs";

const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "edit") {
  log("gh", args);
  process.exit(0);
}
const lookup = args[0] === "api" && /^repos\/([^/]+\/[^/?]+)\/pulls\?head=([^&]+)&state=open$/.exec(args[1] ?? "");
const prs = join(dirname(process.env.FAKE_LOG), "gh-prs.json");
const opens = join(dirname(process.env.FAKE_LOG), "gh-open.json");
if (args[0] === "pr" && args[1] === "create" && existsSync(opens)) {
  const at = (flag) => args[args.indexOf(flag) + 1];
  const repo = at("--repo");
  const head = at("--head");
  if (JSON.parse(readFileSync(opens, "utf8")).includes(`${repo} ${head}`)) {
    log("gh", args);
    const open = existsSync(prs) ? JSON.parse(readFileSync(prs, "utf8")) : {};
    const url = `https://github.com/${repo}/pull/${100 + Object.keys(open).length}`;
    writeFileSync(prs, JSON.stringify({ ...open, [`${repo} ${repo.split("/")[0]}:${head}`]: url }));
    process.stdout.write(`${url}\n`);
    process.exit(0);
  }
}
if (lookup && existsSync(prs)) {
  const url = JSON.parse(readFileSync(prs, "utf8"))[`${lookup[1]} ${decodeURIComponent(lookup[2])}`];
  process.stdout.write(JSON.stringify(url ? [{ html_url: url }] : []));
  process.exit(0);
}
process.exit(1);
