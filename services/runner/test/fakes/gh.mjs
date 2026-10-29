// No GitHub API: every gh call fails (so PRs can't open), as it may on a bad day. Only an edit to
// an open PR's title and description goes through, logged with what it would have written.
import { log } from "./lib.mjs";

const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "edit") {
  log("gh", args);
  process.exit(0);
}
process.exit(1);
