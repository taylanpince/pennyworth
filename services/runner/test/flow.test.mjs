// End to end: the real runner (src/main.mjs) as a child process, from a task on a fake Paperclip
// to a finished job, with fake engines (nix, bwrap, codex, claude, gh) and local repositories for
// GitHub. Unit tests cover the pieces; this covers how they are put together in startJob, where a
// missing repository, a variable used before it was set or a broken engine command line only
// show up when a whole request goes through.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const RUNNER = join(import.meta.dirname, "../src/main.mjs");
const COMPANY = "00000000-0000-4000-8000-000000000001";
const USER = "user-1";

// Each fake logs its argv (and stdin, for the engines) to $FAKE_LOG, then does the least it can.
const FAKES = {
  // nix develop <flake>#<shell> --command … → …
  nix: `const i = process.argv.indexOf("--command");
log("nix", process.argv.slice(2, i));
exec(process.argv.slice(i + 1));`,
  // bwrap … -- … → … (the job's wrapper that hides the gcloud sign-ins, D-48)
  bwrap: `const i = process.argv.indexOf("--");
log("bwrap", process.argv.slice(2, i));
exec(process.argv.slice(i + 1));`,
  // codex exec --output-schema … (the intake) or codex sandbox … -- … (around Claude Code)
  codex: `const args = process.argv.slice(2);
if (args[0] === "sandbox") exec(args.slice(args.indexOf("--") + 1));
else {
  const prompt = readFileSync(0, "utf8");
  log("intake", prompt);
  const candidates = (/^Candidate repositories: (.*)$/m.exec(prompt)?.[1] ?? "").split(", ").filter((c) => c && c !== "(none)");
  if (!prompt.includes("Candidate repositories:")) process.exit(1); // a PR description: falls back to the commits
  const newest = (/<<<COMMENT\\n([\\s\\S]*?)\\nCOMMENT>>>/.exec(prompt) ?? /<<<REQUEST\\n([\\s\\S]*?)\\nREQUEST>>>/.exec(prompt))?.[1] ?? "";
  // Like the real intake on PEN-2714: every repository listed, none picked, and a question.
  const answer = { action: "run", repo: "", references: candidates, mode: "implement", engine: "", model: "", primer: false, question: "Which repository should I use?", gap_minutes: -1, merge_after: false };
  if (/start merging/i.test(newest)) Object.assign(answer, { action: "merge", gap_minutes: 0 });
  if (/then merge/i.test(newest)) Object.assign(answer, { merge_after: true });
  writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(answer));
}`,
  // Claude Code: one session, and a report with the summary a finished run must have.
  claude: `log("claude", { argv: process.argv.slice(2), prompt: readFileSync(0, "utf8") });
const repo = [join(process.cwd(), "app"), join(process.cwd(), "acme/app")].find((d) => existsSync(join(d, ".git")));
const run = (...args) => spawnSync("git", ["-C", repo, ...args], { stdio: "ignore" });
const step = existsSync(process.env.FAKE_STEP) ? readFileSync(process.env.FAKE_STEP, "utf8").trim() : "commit";
if (step === "commit") {
  run("switch", "-qc", "fix/remove-telos", "origin/main");
  writeFileSync(join(repo, "chains.txt"), "polygon\\n");
  run("add", "chains.txt");
  run("commit", "-qm", "fix: drop Telos");
} else {
  // Rewrites the pushed commit, as a rebase does.
  run("switch", "-q", "fix/remove-telos");
  writeFileSync(join(repo, "chains.txt"), "polygon\\n# " + Date.now() + "\\n");
  run("add", "chains.txt");
  run("commit", "-q", "--amend", "-m", "fix: drop Telos");
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" }));
console.log(JSON.stringify({ type: "result", result: "## Summary\\n\\nChecked every repository; nothing needed changing." }));`,
  // No GitHub API: every gh call fails (so PRs can't open), as it may on a bad day.
  gh: `process.exit(1);`,
};

const fakeScript = (body) => `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const log = (kind, data) => appendFileSync(process.env.FAKE_LOG, JSON.stringify({ kind, data }) + "\\n");
const exec = (argv) => process.exit(spawnSync(argv[0], argv.slice(1), { stdio: "inherit" }).status ?? 1);
${body}
`;

const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: { ...process.env, ...gitEnv }, stdio: "pipe" }).toString().trim();
let gitEnv = {};

/** A Paperclip with one parent task (the user's) and one part of it for Ada (D-45). */
function fakePaperclip({ parent, part, engineer }) {
  const issues = new Map([parent, part].map((i) => [i.id, i]));
  const comments = new Map([[parent.id, []], [part.id, []]]);
  const patches = [];
  const activity = [];
  const unknown = [];
  let n = 0;
  const addComment = (issueId, body) => comments.get(issueId).push({ id: `comment-${++n}`, authorType: "user", authorUserId: USER, body, createdAt: new Date().toISOString() });
  const find = (ref) => issues.get(ref) ?? [...issues.values()].find((i) => i.identifier === ref);
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, "http://x");
    const send = (json, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const path = url.pathname;
    const issue = /^\/api\/issues\/([^/]+)/.exec(path)?.[1];
    if (req.method === "GET" && path === `/api/companies/${COMPANY}/labels`) return send([{ id: "label-engineer", name: "engineer" }]);
    if (req.method === "GET" && path === `/api/companies/${COMPANY}/agents`) return send([engineer]);
    if (req.method === "GET" && path === `/api/companies/${COMPANY}/routines`) return send([]);
    if (req.method === "GET" && path === `/api/companies/${COMPANY}/issues`) {
      const q = url.searchParams;
      let list = [...issues.values()];
      if (q.get("labelId")) list = list.filter((i) => (i.labels ?? []).some((l) => l.id === q.get("labelId")));
      if (q.get("assigneeAgentId")) list = list.filter((i) => i.assigneeAgentId === q.get("assigneeAgentId"));
      if (q.get("assigneeUserId")) list = list.filter((i) => i.assigneeUserId === q.get("assigneeUserId"));
      if (q.get("parentId")) list = list.filter((i) => i.parentId === q.get("parentId"));
      return send(list);
    }
    if (req.method === "GET" && path === "/api/cli-auth/me") return send({ userId: USER });
    if (issue && find(decodeURIComponent(issue))) {
      const i = find(decodeURIComponent(issue));
      if (req.method === "GET" && path.endsWith("/comments")) return send(comments.get(i.id));
      if (req.method === "GET" && path.endsWith("/attachments")) return send([]);
      if (req.method === "POST" && path.endsWith("/comments")) {
        addComment(i.id, JSON.parse(body).body);
        return send({ ok: true }, 201);
      }
      if (req.method === "PATCH") {
        const fields = JSON.parse(body);
        patches.push({ issue: i.identifier, ...fields });
        const { comment, ...rest } = fields;
        Object.assign(i, rest, { updatedAt: new Date().toISOString() });
        if (comment) addComment(i.id, comment);
        return send(i);
      }
      if (req.method === "GET") return send(i);
    }
    // The board's internal API (job activity for the Crew view): accepted, not checked.
    if (path.startsWith("/internal/")) {
      if (path.endsWith("/runner/activity")) activity.push(JSON.parse(body));
      return send({});
    }
    unknown.push(`${req.method} ${path}`);
    send({ error: "not found" }, 404);
  });
  return { server, comments, patches, activity, unknown, addComment };
}

describe("runner end to end", () => {
  let dir, runner, paperclip, reportedAtPr = 0, output = "";
  const fakeLog = () => (existsSync(join(dir, "fake.log")) ? readFileSync(join(dir, "fake.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const partComments = () => paperclip.comments.get("part").map((c) => c.body);

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "pennyworth-flow-"));
    const home = join(dir, "home");
    const config = join(dir, "config");
    const secrets = join(dir, "secrets");
    const bin = join(dir, "bin");
    for (const d of [home, config, secrets, bin, join(home, ".config/gcloud")]) mkdirSync(d, { recursive: true });

    // GitHub: bare repositories that git@github.com:<org>/<name>.git resolves to.
    writeFileSync(join(home, ".gitconfig"), `[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n[url "${join(dir, "github")}/"]\n\tinsteadOf = git@github.com:\n`);
    gitEnv = { HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
    for (const slug of ["acme/app", "acme/infra"]) {
      const src = join(dir, "src", slug);
      mkdirSync(src, { recursive: true });
      git(src, "init", "-q");
      writeFileSync(join(src, "README.md"), `# ${slug}\n`);
      git(src, "add", "README.md");
      git(src, "commit", "-qm", "chore: initial commit");
      mkdirSync(dirname(join(dir, "github", slug)), { recursive: true });
      git(dir, "clone", "-q", "--bare", src, join(dir, "github", `${slug}.git`));
    }

    for (const [name, body] of Object.entries(FAKES)) {
      writeFileSync(join(bin, name), fakeScript(body));
      chmodSync(join(bin, name), 0o755);
    }

    writeFileSync(join(config, "system.yaml"), `paperclip:\n  company_id: "${COMPANY}"\nuser:\n  names: ["Taylan"]\n`);
    writeFileSync(
      join(config, "runner.yaml"),
      `label: engineer
poll_seconds: 1
allowed_orgs: [acme]
work_dir: ${join(dir, "work")}
state_dir: ${join(dir, "state")}
max_concurrent: 1
timeout_minutes: 2
engines:
  claude:
    token_file: ${join(secrets, "claude_oauth_token")}
    config_dir: ${join(dir, "state/claude")}
gcp:
  credentials: ${join(secrets, "gcloud/application_default_credentials.json")}
  shell: pulumi
intake:
  timeout_seconds: 30
devshells:
  flake: ${join(dir, "flake")}
  engine_shell: llm
  available: [llm, node, pulumi]
  detect:
    package.json: node
replies:
  enabled: false
reviews:
  enabled: false
recurring:
  enabled: false
`,
    );
    writeFileSync(join(secrets, "paperclip_board_key"), "board-key\n", { mode: 0o600 });
    writeFileSync(join(secrets, "claude_oauth_token"), "claude-token\n", { mode: 0o600 });
    writeFileSync(join(secrets, "board_internal_token"), "board-token\n", { mode: 0o600 });

    // PEN-2713/PEN-2714: the repositories are on the user's task; Ada's part only says go.
    const engineer = { id: "engineer-claude", name: "Engineer · Claude", status: "idle", adapterType: "claude_local", adapterConfig: {}, metadata: { setupKey: "pennyworth:engineer-claude", persona: { name: "Ada" } } };
    const parent = { id: "parent", identifier: "PEN-1", title: "Drop Telos support", status: "todo", assigneeUserId: USER, createdByUserId: USER, createdByAgentId: null, labels: [], description: "Remove Telos from these repos:\n\n- acme/app\n- acme/infra\n" };
    const part = { id: "part", identifier: "PEN-2", title: "Drop Telos support", status: "todo", parentId: "parent", assigneeAgentId: engineer.id, assigneeUserId: null, createdByUserId: USER, createdByAgentId: null, labels: [], description: "Ada, go ahead and start this on dev please" };
    paperclip = fakePaperclip({ parent, part, engineer });
    await new Promise((r) => paperclip.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${paperclip.server.address().port}`;

    runner = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", RUNNER], {
      env: {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:${process.env.PATH}`,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        PENNYWORTH_CONFIG_DIR: config,
        PENNYWORTH_SECRETS_DIR: secrets,
        PENNYWORTH_ENV_FILE: join(dir, "none.env"),
        PAPERCLIP_URL: url,
        BOARD_INTERNAL_URL: `${url}/internal`,
        FAKE_LOG: join(dir, "fake.log"),
        FAKE_STEP: join(dir, "claude-step"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    runner.stdout.on("data", (d) => (output += d));
    runner.stderr.on("data", (d) => (output += d));

    // Done when the job has reported back: the part goes to review with a comment.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !paperclip.patches.some((p) => p.issue === "PEN-2" && p.status === "in_review")) {
      if (runner.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // Then "pr": publishing shows on the board as Ada's work until the results are posted.
    reportedAtPr = paperclip.activity.length;
    paperclip.addComment("part", "pr");
    const prDeadline = Date.now() + 60_000;
    while (Date.now() < prDeadline && !partComments().some((c) => c.includes("| Branch | Result |"))) {
      if (runner.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 500)); // the last activity report
  });

  after(() => {
    runner?.kill("SIGKILL");
    paperclip?.server.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const say = (text) => paperclip.addComment("part", text);
  const waitFor = async (what, ok, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && runner.exitCode === null) {
      if (ok()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.fail(`timed out waiting for ${what}${context()}`);
  };
  const githubTip = () => git(dir, "--git-dir", join(dir, "github/acme/app.git"), "rev-parse", "fix/remove-telos");
  const context = () => `\nrunner output:\n${output.slice(-3000)}\ncomments on the part:\n${partComments().join("\n---\n")}\nunknown requests: ${paperclip.unknown.join(", ")}`;

  it("never asks which repository, and reports no error", () => {
    const comments = partComments();
    assert.ok(!comments.some((c) => /which repositor/i.test(c)), `asked for a repository${context()}`);
    assert.ok(!comments.some((c) => /Runner error|Failed/.test(c)), `the job failed${context()}`);
    assert.ok(!/"msg":"error"/.test(output), `the runner logged an error${context()}`);
  });

  it("starts the job in every repository the user's task lists", () => {
    const started = output.split("\n").filter((l) => l.includes('"job started"')).map((l) => JSON.parse(l));
    assert.equal(started.length, 1, `one job${context()}`);
    assert.deepEqual([...started[0].repos].sort(), ["acme/app", "acme/infra"]);
    assert.equal(started[0].engine, "claude");
    for (const slug of ["acme/app", "acme/infra"]) assert.ok(existsSync(join(dir, "work/tasks/PEN-2", slug.split("/")[1], ".git")) || existsSync(join(dir, "work/tasks/PEN-2", slug, ".git")), `${slug} cloned into the workspace`);
  });

  it("gives the intake the user's task the part belongs to", () => {
    const intake = fakeLog().find((e) => e.kind === "intake")?.data ?? "";
    assert.match(intake, /Candidate repositories: .*acme\/app/);
    assert.match(intake, /Candidate repositories: .*acme\/infra/);
    assert.match(intake, /The task this is part of \(PEN-1\)/);
  });

  it("runs Claude Code in the devshells, the sandbox and bwrap, with a prompt naming every repository", () => {
    const log = fakeLog();
    const claude = log.find((e) => e.kind === "claude")?.data;
    assert.ok(claude, `Claude Code never ran${context()}`);
    assert.match(claude.prompt, /acme\/app/);
    assert.match(claude.prompt, /acme\/infra/);
    assert.match(claude.prompt, /Drop Telos support/);
    assert.ok(claude.argv.includes("--strict-mcp-config"), "Claude Code keeps away from the user's own setup");
    // The engine's devshell is outermost; the gcloud sign-ins are hidden from the job (D-48).
    const shells = log.filter((e) => e.kind === "nix").map((e) => e.data[1]);
    assert.ok(shells.some((s) => s.endsWith("#llm")), `nix develop …#llm${context()}`);
    const bwrap = log.find((e) => e.kind === "bwrap")?.data ?? [];
    assert.ok(bwrap.includes("--tmpfs") && bwrap.some((a) => a.endsWith(".config/gcloud")), "bwrap hides ~/.config/gcloud");
  });

  it("shows a pr on the board as work in progress until the results are posted", () => {
    const reports = paperclip.activity.slice(reportedAtPr);
    const publishing = reports.find((a) => a.running.some((r) => r.identifier === "PEN-2"));
    assert.ok(publishing, `never reported as running${context()}`);
    assert.equal(publishing.running.find((r) => r.identifier === "PEN-2").mode, "opening PRs");
    assert.match(publishing.running.find((r) => r.identifier === "PEN-2").repo, /acme\/app/);
    assert.deepEqual(reports.at(-1).running, [], "and no longer running afterwards");
    const table = partComments().find((c) => c.includes("| Branch | Result |"));
    assert.match(table, /fix\/remove-telos/);
    // Pushed for real (to the local "GitHub"); the PR itself can't open without the GitHub API.
    assert.ok(git(dir, "--git-dir", join(dir, "github/acme/app.git"), "branch", "--list", "fix/remove-telos"), "branch pushed");
  });

  it("posts the agent's report and moves the part to review", () => {
    const done = paperclip.patches.find((p) => p.issue === "PEN-2" && p.status === "in_review");
    assert.ok(done, `no report${context()}`);
    assert.match(done.comment, /Checked every repository/);
    assert.ok(paperclip.patches.some((p) => p.issue === "PEN-2" && p.status === "in_progress" && /On it/.test(p.comment)), "On it, first");
  });

  // PEN-2714: "start merging" with no PRs named, then the list as a reply.
  it("asks which PRs to merge, and the reply that lists them starts the merges", async () => {
    let n = partComments().length;
    say("Start merging approved PRs in order.");
    await waitFor("the question", () => partComments().slice(n).some((c) => /Which pull requests should I merge/.test(c)));
    n = partComments().length;
    say("1. https://github.com/acme/app/pull/1");
    await waitFor("the merges", () => partComments().slice(n).some((c) => /merging 1 PR.*#1/.test(c)));
  });

  // PEN-2714: "fix the conflict by rebasing, then merge them as I instructed", then push.
  it("after a rebase, push replaces the task's own branch and starts the merges asked for", async () => {
    writeFileSync(join(dir, "claude-step"), "amend");
    const before = githubTip();
    let n = partComments().length;
    say("Rebase it on main, then merge them one by one as I listed.");
    await waitFor("the run, and the note about merging", () => partComments().slice(n).some((c) => /merges you asked for: reply \*\*push\*\*/.test(c)));
    assert.ok(!partComments().slice(n).some((c) => /merging \d+ PR/.test(c)), "no merges before the push");
    // "As I listed": the run sees the conversation since its last reply, and where the work stands.
    const prompt = fakeLog().filter((e) => e.kind === "claude").at(-1).data.prompt;
    assert.match(prompt, /## On this task since your last reply/);
    assert.match(prompt, /### Taylan [^\n]*\n\n1\. https:\/\/github\.com\/acme\/app\/pull\/1/, "the list the user gave");
    assert.match(prompt, /<<<RUNNER\nWhich pull requests should I merge/, "the question it answered");
    assert.match(prompt, /## Where things stand \(read just now\)[\s\S]*\| acme\/app \| `fix\/remove-telos` \|/);
    assert.match(prompt, /## Instructions from Taylan \(authoritative\)[\s\S]*Rebase it on main, then merge them/);
    assert.doesNotMatch(prompt.split("## Instructions from Taylan")[0], /Rebase it on main/, "this run's request isn't repeated in the conversation");
    n = partComments().length;
    say("push");
    await waitFor("the push", () => partComments().slice(n).some((c) => /\| Branch \| Result \|/.test(c)));
    const table = partComments().slice(n).find((c) => /\| Branch \| Result \|/.test(c));
    assert.match(table, /Replaced the earlier version/, table);
    assert.notEqual(githubTip(), before, "GitHub has the rewritten branch");
    await waitFor("the merges, from the earlier list", () => partComments().slice(n).some((c) => /merging 1 PR.*#1/.test(c)));
  });

  it("never replaces commits someone else pushed to the branch", async () => {
    // A reviewer's commit on the PR branch, on "GitHub".
    const other = join(dir, "reviewer");
    git(dir, "clone", "-q", "--branch", "fix/remove-telos", join(dir, "github/acme/app.git"), other);
    writeFileSync(join(other, "review.txt"), "a fix\n");
    git(other, "add", "review.txt");
    git(other, "commit", "-qm", "fix: review comment");
    git(other, "push", "-q", "origin", "fix/remove-telos");
    const theirs = githubTip();
    let n = paperclip.patches.length;
    say("Reword the commit, please.");
    await waitFor("the run", () => paperclip.patches.slice(n).some((p) => p.issue === "PEN-2" && p.status === "in_review"));
    n = partComments().length;
    say("push");
    await waitFor("the push", () => partComments().slice(n).some((c) => /\| Branch \| Result \|/.test(c)));
    assert.match(partComments().slice(n).find((c) => /\| Branch \|/.test(c)), /didn't make/);
    assert.equal(githubTip(), theirs, "their commit is still there");
  });
});
