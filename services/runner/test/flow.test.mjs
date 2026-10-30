// End to end: the real runner (src/main.mjs) as a child process, talking to a fake Paperclip, with
// fake engines (test/fakes: nix, bwrap, codex, claude, gh) and local repositories for GitHub. Unit
// tests cover the pieces; this replays conversations on a task (PEN-2713/PEN-2714's shape: the user's
// task lists the repositories, Ada's part of it says "go ahead") turn by turn, the way the user has
// them, and checks what reached the agent, GitHub and the task.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { State } from "../src/state.mjs";

const RUNNER = join(import.meta.dirname, "../src/main.mjs");
const FAKES = join(import.meta.dirname, "fakes");
const COMPANY = "00000000-0000-4000-8000-000000000001";
const USER = "user-1";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: { ...process.env, ...gitEnv }, stdio: "pipe" }).toString().trim();
let gitEnv = {};

/** A Paperclip with one parent task (the user's) and one part of it for Ada (D-45). */
function fakePaperclip({ parent, part, engineers, parentComments = [] }) {
  const issues = new Map([parent, part].map((i) => [i.id, i]));
  const comments = new Map([[parent.id, parentComments], [part.id, []]]);
  const patches = [];
  const activity = [];
  const unknown = [];
  let n = 0;
  const addComment = (issueId, body) => comments.get(issueId).push({ id: `comment-${++n}`, authorType: "user", authorUserId: USER, body, createdAt: new Date(Date.now() + n).toISOString() });
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
    if (req.method === "GET" && path === `/api/companies/${COMPANY}/agents`) return send(engineers);
    if (req.method === "GET" && path === `/api/companies/${COMPANY}/routines`) return send([]);
    if (req.method === "GET" && path === `/api/companies/${COMPANY}/issues`) {
      const q = url.searchParams;
      let list = [...issues.values()];
      if (q.get("labelId")) list = list.filter((i) => (i.labels ?? []).some((l) => l.id === q.get("labelId")));
      if (q.get("assigneeAgentId")) list = list.filter((i) => i.assigneeAgentId === q.get("assigneeAgentId"));
      if (q.get("assigneeUserId")) list = list.filter((i) => i.assigneeUserId === q.get("assigneeUserId"));
      if (q.get("parentId")) list = list.filter((i) => i.parentId === q.get("parentId"));
      if (q.get("q")) list = list.filter((i) => `${i.title}\n${i.description}`.toLowerCase().includes(q.get("q").toLowerCase()));
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
    // The board's internal API: the runner's activity for the Crew view.
    if (path.startsWith("/internal/")) {
      if (path.endsWith("/runner/activity")) activity.push(JSON.parse(body));
      return send({});
    }
    unknown.push(`${req.method} ${path}`);
    send({ error: "not found" }, 404);
  });
  return { server, comments, patches, activity, unknown, addComment };
}

describe("talking to an Engineer, end to end", () => {
  let dir, runner, paperclip, output = "";
  const fakeLog = () => (existsSync(join(dir, "fake.log")) ? readFileSync(join(dir, "fake.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const partComments = () => paperclip.comments.get("part").map((c) => c.body);
  const claudeRuns = () => fakeLog().filter((e) => e.kind === "claude").map((e) => e.data);
  const toolRuns = () => fakeLog().filter((e) => e.kind === "tool").map((e) => e.data);
  const step = (text) => writeFileSync(join(dir, "claude-step"), text);
  const say = (text) => paperclip.addComment("part", text);
  const context = () => `\nrunner output:\n${output.slice(-3000)}\ncomments on the part:\n${partComments().join("\n---\n")}\nunknown requests: ${paperclip.unknown.join(", ")}`;
  const waitFor = async (what, ok, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && runner.exitCode === null) {
      if (ok()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.fail(`timed out waiting for ${what}${context()}`);
  };
  const reviews = () => paperclip.patches.filter((p) => p.issue === "PEN-2" && p.status === "in_review");
  const starts = () => paperclip.patches.filter((p) => p.issue === "PEN-2" && p.status === "in_progress");
  /** One turn: the user's comment, then the agent's reply (the part back in review). */
  const turn = async (comment) => {
    const n = reviews().length;
    say(comment);
    await waitFor(`the reply to "${comment}"`, () => reviews().length > n);
    return reviews().at(-1);
  };
  const githubTip = (branch = "fix/remove-telos") => git(dir, "--git-dir", join(dir, "github/acme/app.git"), "rev-parse", branch);

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
    for (const name of ["nix", "bwrap", "codex", "claude", "gh"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${join(FAKES, `${name}.mjs`)}" "$@"\n`);
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
    const engineers = [
      { id: "engineer-claude", name: "Engineer · Claude", status: "idle", adapterType: "claude_local", adapterConfig: {}, metadata: { setupKey: "pennyworth:engineer-claude", persona: { name: "Ada" } } },
      { id: "engineer-codex", name: "Engineer · Codex", status: "idle", adapterType: "codex_local", adapterConfig: {}, metadata: { setupKey: "pennyworth:engineer-codex", persona: { name: "Grace" } } },
    ];
    const parent = { id: "parent", identifier: "PEN-1", title: "Drop Telos support", status: "todo", assigneeUserId: USER, createdByUserId: USER, createdByAgentId: null, labels: [], description: "Remove Telos from these repos:\n\n- acme/app\n- acme/infra\n" };
    const part = { id: "part", identifier: "PEN-2", title: "Drop Telos support", status: "todo", parentId: "parent", assigneeAgentId: "engineer-claude", assigneeUserId: null, createdByUserId: USER, createdByAgentId: null, labels: [], description: "Ada, go ahead and start this on dev please" };
    // PEN-3155: Alfred's report is a comment on the user's task, and the user asks Ada to take it over.
    const alfred = { id: "assistant", name: "Assistant", status: "idle", adapterType: "codex_local", adapterConfig: {}, metadata: { setupKey: "pennyworth:assistant", persona: { name: "Alfred" } } };
    const parentComments = [{ id: "alfred-report", authorType: "agent", authorAgentId: "assistant", body: "## Telos usage — preliminary\n\nTelos is still read by the infra alerts.", createdAt: new Date(Date.now() - 60_000).toISOString() }];
    paperclip = fakePaperclip({ parent, part, engineers: [...engineers, alfred], parentComments });
    await new Promise((r) => paperclip.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${paperclip.server.address().port}`;

    step("commit");
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
  });

  after(() => {
    runner?.kill("SIGKILL");
    paperclip?.server.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("starts from the user's own words on assignment, in every repository their task lists, without asking", async () => {
    await waitFor("the first reply", () => reviews().length > 0);
    const started = output.split("\n").filter((l) => l.includes('"job started"')).map((l) => JSON.parse(l));
    assert.deepEqual([...started[0].repos].sort(), ["acme/app", "acme/infra"]);
    assert.equal(started[0].engine, "claude");
    assert.ok(!partComments().some((c) => /which repositor|Runner error|Failed/i.test(c)), `no questions or errors${context()}`);
    const { prompt, argv } = claudeRuns()[0];
    assert.match(prompt, /acme\/app[\s\S]*acme\/infra|acme\/infra[\s\S]*acme\/app/);
    assert.match(prompt, /The task this is part of[\s\S]*Drop Telos support/);
    assert.match(prompt, /<<<PARENT_CONVERSATION\n### Alfred · [^\n]*\n\n## Telos usage — preliminary\n\nTelos is still read by the infra alerts\./, "Alfred's report on the user's task");
    assert.match(prompt, /`pennyworth task PEN-N` prints one in full/);
    assert.match(prompt, /## Instructions from Taylan \(authoritative\)[\s\S]*Ada, go ahead and start this on dev please/);
    assert.match(prompt, /The engineering agents, by name: Ada \(claude\), Grace \(codex\)/);
    assert.doesNotMatch(prompt, /Mode: \*\*|## Summary/, "no modes, no report template");
    assert.ok(argv.includes("--strict-mcp-config"), "Claude Code keeps away from the user's own setup");
    // Engines run in the devshells, with the gcloud sign-ins hidden (D-48).
    assert.ok(fakeLog().some((e) => e.kind === "nix" && e.data[1].endsWith("#llm")));
    const bwrap = fakeLog().find((e) => e.kind === "bwrap")?.data ?? [];
    assert.ok(bwrap.includes("--tmpfs") && bwrap.some((a) => a.endsWith(".config/gcloud")));
  });

  it("posts the agent's reply as its own, with no start notes around it", () => {
    const reply = reviews()[0].comment;
    assert.match(reply, /^<!-- pennyworth-reply -->Checked every repository/);
    assert.match(reply, /fix\/remove-telos/, "the branch it committed, in the footer");
    assert.ok(starts().length && !starts()[0].comment, "the board shows the work; no \"On it\" comment");
  });

  it("keeps the exact word pr as a shortcut, shown on the board while it publishes", async () => {
    const reported = paperclip.activity.length;
    const n = partComments().length;
    say("pr");
    await waitFor("the results", () => partComments().slice(n).some((c) => c.includes("| Branch | Result |")));
    await new Promise((r) => setTimeout(r, 500));
    const publishing = paperclip.activity.slice(reported).find((a) => a.running.some((r) => r.identifier === "PEN-2"));
    assert.equal(publishing?.running.find((r) => r.identifier === "PEN-2").mode, "opening PRs");
    assert.deepEqual(paperclip.activity.at(-1).running, []);
    assert.ok(git(dir, "--git-dir", join(dir, "github/acme/app.git"), "branch", "--list", "fix/remove-telos"), "pushed");
    assert.equal(claudeRuns().length, 1, "no agent turn for the shortcut");
  });

  // PEN-2714: a list of PRs, then "fix the conflict by rebasing, then start merging them as I listed".
  it("reads 'as I listed' from the conversation, then pushes the rebase and queues the merges itself", async () => {
    step("none");
    await turn("Here's the order: 1. https://github.com/acme/app/pull/1");
    const before = githubTip();
    step("amend\npennyworth push acme/app fix/remove-telos\npennyworth merge https://github.com/acme/app/pull/1 --gap 0");
    const n = partComments().length;
    const reply = await turn("Rebase it on main, then start merging them as I listed.");
    const [push, merge] = toolRuns().slice(-2);
    assert.equal(push.code, 0, push.out);
    assert.match(push.out, /Replaced the earlier version with 1 commit/);
    assert.notEqual(githubTip(), before, "GitHub has the rewritten branch");
    assert.match(merge.out, /Queued #1: the merges start when this run ends/);
    // The merges start once the run is over, after its reply.
    await waitFor("the merges", () => partComments().slice(n).some((c) => /merging 1 PR.*#1/.test(c)));
    const order = partComments().slice(n);
    assert.ok(order.findIndex((c) => c === reply.comment) < order.findIndex((c) => /merging 1 PR/.test(c)), "reply first, then merges");
    // The check saw the user's words, never the task's text.
    const check = fakeLog().filter((e) => e.kind === "authorize").at(-1).data;
    assert.match(check, /RECENT_COMMENTS_FROM_TAYLAN\n[^\n]*Rebase it on main, then start merging them as I listed/);
    assert.doesNotMatch(check, /Remove Telos from these repos/);
  });

  it("refuses a write the user didn't ask for, and tells the agent to ask", async () => {
    // A new commit to push, so the push really has to be checked.
    step("amend\npennyworth push acme/app fix/remove-telos");
    const tip = githubTip();
    await turn("Look into why CI is red.");
    const call = toolRuns().at(-1);
    assert.equal(call.code, 1);
    assert.match(call.out, /Not done: this needs Taylan's go-ahead \(not asked\)[\s\S]*ask them/);
    assert.equal(githubTip(), tip, "nothing pushed");
  });

  it("pushes when the user asks in their own words", async () => {
    step("second\npennyworth push acme/app feat/second");
    await turn("Add the second change, and go ahead and push it.");
    const call = toolRuns().at(-1);
    assert.equal(call.code, 0, call.out);
    assert.match(call.out, /feat\/second[\s\S]*Pushed 1 commit/);
    assert.ok(githubTip("feat/second"), "on GitHub");
    assert.ok(partComments().some((c) => /\| Branch \| Result \|[\s\S]*feat\/second/.test(c)), "on record on the task");
  });

  it("never replaces commits someone else pushed to the branch", async () => {
    const other = join(dir, "reviewer");
    git(dir, "clone", "-q", "--branch", "fix/remove-telos", join(dir, "github/acme/app.git"), other);
    writeFileSync(join(other, "review.txt"), "a fix\n");
    git(other, "add", "review.txt");
    git(other, "commit", "-qm", "fix: review comment");
    git(other, "push", "-q", "origin", "fix/remove-telos");
    const theirs = githubTip();
    step("amend\npennyworth push acme/app fix/remove-telos");
    await turn("Reword the commit, then push it.");
    assert.match(toolRuns().at(-1).out, /didn't make/);
    assert.equal(githubTip(), theirs, "their commit is still there");
  });

  it("stops a run when told to, mid-run", async () => {
    step("slow");
    const n = starts().length;
    say("Check the staging logs for errors.");
    await waitFor("the run to start", () => starts().length > n);
    await new Promise((r) => setTimeout(r, 1000));
    say("stop");
    await waitFor("the stop", () => reviews().some((p) => /Stopped on request/.test(p.comment ?? "")), 30_000);
  });

  it("answers a progress question mid-run, and passes other comments into the running session", async () => {
    step("slow");
    const n = starts().length;
    const c = partComments().length;
    const replies = reviews().length;
    say("Look at the staging logs again.");
    await waitFor("the run to start", () => starts().length > n);
    await new Promise((r) => setTimeout(r, 1000));
    say("How's it going?");
    await waitFor("the answer", () => partComments().slice(c).some((x) => /Still running/.test(x)), 20_000);
    say("Also check the infra repo.");
    await waitFor("the hand-over", () => partComments().slice(c).some((x) => /Passed on: Ada reads it now/.test(x)), 20_000);
    // Claude Code takes it in mid-run (stage 4): one reply that covers it, no extra turn.
    await waitFor("the reply", () => reviews().length > replies);
    assert.match(reviews().at(-1).comment, /Also, as you asked while I worked: Also check the infra repo\./);
    assert.deepEqual(fakeLog().filter((e) => e.kind === "claude-mid-run").at(-1).data, ["Also check the infra repo."]);
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(reviews().length, replies + 1, "no second turn for it");
  });

  // An agent turn or publishing in progress (the merge queue runs on in the background: GitHub fails here).
  const running = () => (paperclip.activity.at(-1)?.running ?? []).some((r) => r.identifier === "PEN-2" && r.mode !== "merging PRs");

  it("switches engine when asked, and runs the request again on a fresh session with the whole conversation", async () => {
    await waitFor("quiet", () => !running());
    step("none\npennyworth engine claude sonnet");
    const runs = claudeRuns().length;
    say("Use Sonnet for this one, and summarise what changed.");
    await waitFor("the run on the new model", () => claudeRuns().length >= runs + 2);
    const again = claudeRuns()[runs + 1];
    assert.equal(again.argv[again.argv.indexOf("--model") + 1], "sonnet");
    assert.ok(!again.argv.includes("--resume"), "a fresh session");
    assert.match(again.prompt, /## The conversation on this task[\s\S]*Here's the order: 1\. https:\/\/github\.com\/acme\/app\/pull\/1/, "the whole conversation, from the start");
    assert.match(again.prompt, /## Instructions from Taylan[\s\S]*Use Sonnet for this one/);
    assert.ok(paperclip.patches.some((p) => p.issue === "PEN-2" && p.assigneeAdapterOverrides?.adapterConfig?.model === "sonnet"), "the picker shows it");
    step("none");
    await waitFor("quiet", () => !running());
  });

  // PEN-3024: Ada's description was swapped for a generated one over Claude Code's footer, and an
  // open PR's description couldn't be changed at all.
  it("updates an open PR's description with the agent's own, and sends a leaky one back to it", async () => {
    new State(join(dir, "state")).updateBranch("part", "acme/app", "feat/second", { pr_url: "https://github.com/acme/app/pull/7" });
    const edits = () => fakeLog().filter((e) => e.kind === "gh");
    step("describe-leak\npennyworth pr acme/app feat/second --title fix:-drop-Telos --body-file .pennyworth/pr-body.md");
    await turn("Go ahead and write a proper description on the PR.");
    const refused = toolRuns().at(-1);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /mentions "Paperclip"[\s\S]*reword it/);
    assert.equal(edits().length, 0, "nothing sent to GitHub");

    step("describe\npennyworth pr acme/app feat/second --title fix:-drop-Telos --body-file .pennyworth/pr-body.md");
    await turn("Go ahead, without the internal name.");
    const call = toolRuns().at(-1);
    assert.equal(call.code, 0, call.out);
    assert.match(call.out, /Updated the title and description of https:\/\/github.com\/acme\/app\/pull\/7/);
    const edit = edits().at(-1).data;
    assert.deepEqual(edit.slice(0, 5), ["pr", "edit", "https://github.com/acme/app/pull/7", "--title", "fix:-drop-Telos"]);
    assert.equal(edit[6], "## Why\n\nTelos is gone.", "the agent's text, without the footer");
  });

  it("reads another task's whole conversation, and finds tasks by agent or words", async () => {
    step("none\npennyworth task pen-1\npennyworth tasks --agent Ada\npennyworth tasks telos\npennyworth tasks --agent Nobody");
    await turn("Take over Alfred's report.");
    const [task, byAgent, byWords, nobody] = toolRuns().slice(-4);
    assert.equal(task.code, 0, task.out);
    assert.match(task.out, /^PEN-1: Drop Telos support\nStatus: todo · with Taylan[^\n]*\nParts: PEN-2 \(Ada, in_progress\)/);
    assert.match(task.out, /<<<TASK\nDescription:\n\nRemove Telos from these repos[\s\S]*### Alfred · [^\n]*\n\n## Telos usage — preliminary[\s\S]*TASK>>>/);
    assert.match(byAgent.out, /^PEN-2 · in_progress · with Ada · /);
    assert.match(byWords.out, /PEN-1 · todo · with Taylan/);
    assert.equal(nobody.code, 1);
    assert.match(nobody.out, /No agent is called Nobody: Ada, Grace, Alfred/);
  });

  it("says nothing to a comment that needs no answer", async () => {
    await new Promise((r) => setTimeout(r, 1500));
    step("silent");
    const n = partComments().length;
    const done = await turn("Thanks!");
    assert.equal(done.comment, undefined);
    assert.equal(partComments().length, n + 1, "only the user's comment");
  });

  it("never errors or asks for a repository along the way", () => {
    assert.ok(!/"msg":"error"/.test(output), `the runner logged an error${context()}`);
    assert.ok(!partComments().some((c) => /Which repository|Runner error/.test(c)));
  });
});
