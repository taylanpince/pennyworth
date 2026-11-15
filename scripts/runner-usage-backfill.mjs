#!/usr/bin/env node
// What the runner's earlier jobs used (D-62), from their logs: fills the jobs table's usage and who-ran-it
// columns, and the session totals the runner measures the next job from. The runner then sends the
// board every job it hasn't had. Safe to run again: jobs are recomputed in the order they started (so a
// resumed session's running totals chain), a job whose numbers change goes back to unsent, and the
// runner's own records (agent, model, effort) are kept. Reads Paperclip as the user (GET only).
//
//   node scripts/runner-usage-backfill.mjs [--state-dir DIR] [--dry-run] [--no-paperclip] [--report FROM..TO]
//
// --state-dir   the runner's state directory (default: the runner's own, from its config)
// --dry-run     compute and report, write nothing
// --no-paperclip  skip the assignee and comment lookups (agent and retry stay as they are)
// --report      print totals for jobs started in [FROM, TO] (dates, inclusive)

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../services/runner/src/config.mjs";
import { RUNNER_MARKER, stripHidden } from "../services/runner/src/commands.mjs";
import { Paperclip } from "../services/runner/src/paperclip.mjs";
import { State } from "../services/runner/src/state.mjs";
import { engineKind, isRetry, usageFromEvents, usageFromLog } from "../services/runner/src/usage.mjs";

const { values: opts } = parseArgs({
  options: { "state-dir": { type: "string" }, "dry-run": { type: "boolean" }, "no-paperclip": { type: "boolean" }, report: { type: "string" } },
});
const cfg = loadConfig();
const stateDir = opts["state-dir"] ?? cfg.stateDir;
if (!existsSync(join(stateDir, "state.sqlite"))) throw new Error(`no runner state in ${stateDir}`);
const state = new State(stateDir);
const pc = opts["no-paperclip"] ? undefined : new Paperclip(cfg);

/** The task's assignee now (its role, D-60), and the user's comments, once per task. */
const tasks = new Map();
async function taskInfo(issueId) {
  if (!pc) return undefined;
  if (!tasks.has(issueId)) {
    const [issue, comments] = await Promise.all([pc.issue(issueId).catch(() => undefined), pc.comments(issueId).catch(() => [])]);
    const own = comments.filter((c) => c.authorType === "user" && !c.authorAgentId && !c.body?.includes(RUNNER_MARKER) && !c.body?.includes("<!-- pennyworth-reply -->"));
    tasks.set(issueId, { agentId: issue?.assigneeAgentId ?? null, comments: own });
  }
  return tasks.get(issueId);
}

/** "Claude Code (claude-opus-5-5, high effort)" → model and effort. */
function fromLabel(label) {
  const inner = /\(([^)]*)\)\s*$/.exec(String(label ?? ""))?.[1];
  const parts = inner ? inner.split(",").map((s) => s.trim()) : [];
  const effort = parts.find((p) => p.endsWith(" effort"))?.replace(/ effort$/, "") ?? null;
  const model = parts.find((p) => !p.endsWith(" effort")) ?? (String(label).startsWith("OpenRouter ") ? String(label).slice(11).trim() : null);
  return { model, effort };
}

const jobs = state.db.prepare("SELECT jobs.*, tasks.identifier FROM jobs JOIN tasks USING (issue_id) ORDER BY jobs.started_at, jobs.id").all();
const sessions = new Map(); // session → its totals after the latest job so far
const lastStart = new Map(); // task → when its previous job started
const seenSessions = new Set();
let changed = 0;
let missing = 0;
const computed = [];
for (const job of jobs) {
  const previousStart = lastStart.get(job.issue_id) ?? "";
  lastStart.set(job.issue_id, job.started_at);
  if (job.status === "running") continue; // its log isn't finished; the runner records it at the end
  let engine = engineKind(job.engine);
  const read = job.log_path ? await usageFromLog(job.log_path, { engine, previousSession: (id) => sessions.get(id) }) : undefined;
  if (!read) missing++;
  engine ??= read?.header?.kind;
  const usage = read?.usage ?? usageFromEvents([], { engine });
  if (usage.sessionId && usage.sessionAfter) sessions.set(usage.sessionId, usage.sessionAfter);
  const resumed = Boolean(usage.sessionId && seenSessions.has(usage.sessionId));
  if (usage.sessionId) seenSessions.add(usage.sessionId);

  const fields = {};
  const usageJson = JSON.stringify(usage);
  if (job.usage_json !== usageJson) fields.usage_json = usageJson;
  const label = fromLabel(job.engine);
  if (job.model == null && (read?.header?.model ?? label.model)) fields.model = read?.header?.model ?? label.model;
  if (job.effort == null && label.effort) fields.effort = label.effort;
  if (job.resumed == null) fields.resumed = resumed;
  if (job.restarted == null) fields.restarted = false; // not recorded before D-62
  const info = await taskInfo(job.issue_id);
  if (info) {
    if (job.agent_id == null && info.agentId) fields.agent_id = info.agentId;
    if (job.retry == null) {
      // The user's last comment before the job started, since the task's previous job.
      const asked = info.comments.filter((c) => c.createdAt > previousStart && c.createdAt <= job.started_at).at(-1);
      fields.retry = Boolean(asked && isRetry(stripHidden(asked.body)));
    }
  }
  if (Object.keys(fields).length) {
    changed++;
    // New numbers: the board gets this job again (it keeps one row per job id).
    if (fields.usage_json && job.sent_at) fields.sent_at = null;
    if (!opts["dry-run"]) state.updateJob(job.id, fields);
  }
  computed.push({ ...job, ...fields, usage });
}
// Where each session stands, for the runner's next job on it (only sessions the logs went further on).
if (!opts["dry-run"]) {
  for (const [id, after] of sessions) {
    const saved = state.get(`session_cost:${id}`);
    const prev = saved ? JSON.parse(saved) : undefined;
    if (!prev || (after.costUsd ?? 0) >= (prev.costUsd ?? 0)) state.set(`session_cost:${id}`, JSON.stringify(after));
  }
}
console.log(JSON.stringify({ jobs: jobs.length, changed, withoutLog: missing, sessions: sessions.size, dryRun: Boolean(opts["dry-run"]) }));

if (opts.report) {
  const [from, to] = opts.report.split("..");
  const inRange = computed.filter((j) => j.started_at.slice(0, 10) >= from && j.started_at.slice(0, 10) <= to);
  const sum = (list, f) => list.reduce((a, j) => a + (f(j) ?? 0), 0);
  const kind = (j) => engineKind(j.engine);
  const byTask = new Map();
  for (const j of inRange) byTask.set(j.identifier, (byTask.get(j.identifier) ?? 0) + (j.usage.costUsd ?? 0));
  const round = (v) => Math.round(v * 100) / 100;
  console.log(
    JSON.stringify(
      {
        range: opts.report,
        jobs: inRange.length,
        byEngine: Object.fromEntries(["claude", "codex", "openrouter"].map((k) => [k, inRange.filter((j) => kind(j) === k).length])),
        claudeCost: round(sum(inRange.filter((j) => kind(j) === "claude"), (j) => j.usage.costUsd)),
        claudeCostNaive: round(sum(inRange.filter((j) => kind(j) === "claude"), (j) => j.usage.sessionCostAfter)),
        openrouterCost: round(sum(inRange.filter((j) => kind(j) === "openrouter"), (j) => j.usage.costUsd)),
        tokens: Object.fromEntries(["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"].map((k) => [k, sum(inRange, (j) => j.usage[k])])),
        resumed: inRange.filter((j) => j.resumed).length,
        retries: inRange.filter((j) => j.retry).length,
        withAgent: inRange.filter((j) => j.agent_id).length,
        topTasks: [...byTask].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, c]) => `${t} $${round(c)}`),
        mostSubagents: inRange.sort((a, b) => b.usage.subagents - a.usage.subagents).slice(0, 3).map((j) => `${j.identifier} ${j.started_at.slice(0, 16)}: ${j.usage.subagents} subagents, $${round(j.usage.costUsd ?? 0)}`),
      },
      null,
      2,
    ),
  );
}
