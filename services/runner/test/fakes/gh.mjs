// No GitHub API: every gh call fails, as it may on a bad day. Only an edit to an open PR's title and
// description goes through, logged with what it would have written; a lookup of a branch's open PR
// answers from gh-prs.json next to the log (PRs the user opened); and a draft PR opens, into that file,
// for a branch named in gh-open.json (a list of "<repo> <branch>"), so other PRs still fail to open.
// The PR watch's query answers from gh-watch.json (PR number → pullRequest), else an open PR with no
// activity; `api user` is the user's login.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./lib.mjs";

const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "user" && args.includes("--jq")) {
  process.stdout.write("taylan\n");
  process.exit(0);
}
// A PR's state and head for the cross-model review: open, with the head in gh-heads.json (URL → oid).
if (args[0] === "pr" && args[1] === "view" && args.at(-1) === "state,headRefOid") {
  const heads = join(dirname(process.env.FAKE_LOG), "gh-heads.json");
  process.stdout.write(JSON.stringify({ state: "OPEN", headRefOid: (existsSync(heads) ? JSON.parse(readFileSync(heads, "utf8")) : {})[args[2]] ?? "head-1" }));
  process.exit(0);
}
const field = (name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
if (args[0] === "api" && args[1] === "graphql" && field("query")?.includes("authorAssociation")) {
  const watched = join(dirname(process.env.FAKE_LOG), "gh-watch.json");
  const number = Number(field("number"));
  const url = `https://github.com/${field("owner")}/${field("repo")}/pull/${number}`;
  const pr = (existsSync(watched) ? JSON.parse(readFileSync(watched, "utf8")) : {})[number] ?? {};
  log("gh-watch", number);
  const open = { number, url, title: "Late clone", state: "OPEN", merged: false, headRefOid: "head-1", reviews: { nodes: [] }, comments: { nodes: [] }, commits: { nodes: [] } };
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { ...open, ...pr } } } }));
  process.exit(0);
}
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
