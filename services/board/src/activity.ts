// What the agents are doing: Paperclip's agent runs plus the runner's Engineer jobs, which it
// reports to the internal API (the runner works outside Paperclip, on the host).
import { z } from "zod";
import type { Agent, Issue, LiveRun, PastRun } from "./paperclip.js";

const UUID = /^[0-9a-f-]{36}$/;
const IDENT = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;

const RunnerJobSchema = z
  .object({
    issueId: z.string().regex(UUID),
    identifier: z.string().regex(IDENT),
    engine: z.string().max(200).optional(),
    mode: z.string().max(40).optional(),
    repo: z.string().max(200).optional(),
    status: z.string().max(40).optional(),
    startedAt: z.string().max(40),
    finishedAt: z.string().max(40).nullable().optional(),
  })
  .strict();

export const RunnerReportSchema = z
  .object({
    running: z.array(RunnerJobSchema).max(50),
    queued: z.array(z.object({ issueId: z.string().regex(UUID), identifier: z.string().regex(IDENT) }).strict()).max(200),
    recent: z.array(RunnerJobSchema).max(50),
  })
  .strict();

export type RunnerReport = z.infer<typeof RunnerReportSchema> & { at: string };
type RunnerJob = z.infer<typeof RunnerJobSchema>;

/** The runner polls every ~20 seconds; a minute of silence while it acts on a request is normal. */
export const RUNNER_STALE_MS = 5 * 60_000;
const FINISHED_WINDOW_MS = 12 * 3_600_000;

export interface TaskRef {
  identifier: string;
  title?: string;
}

export interface Session {
  id: string;
  source: "agent" | "runner";
  agent: string;
  /** The Paperclip agent behind it: the run's agent, or the Engineer of a runner job's engine. */
  agentId: string | null;
  state: "working" | "queued";
  startedAt: string | null;
  /** Paperclip's status line for the run ("Receiving agent output"), or the runner's mode and repo. */
  doing?: string;
  tool?: string;
  /** The agent's latest message, when Paperclip has one. */
  said?: string;
  /** No output for a long while (Paperclip's silence warning). */
  quiet?: boolean;
  /** The task the run belongs to: the user's task, or a routine's run task ("Process task replies"). */
  run: TaskRef | null;
  /** The user's tasks it works on: the task itself, or those a routine run names. */
  tasks: TaskRef[];
}

export interface Finished {
  id: string;
  source: "agent" | "runner";
  agent: string;
  agentId: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  detail?: string;
  run: TaskRef | null;
  tasks: TaskRef[];
}

export interface AgentsView {
  sessions: Session[];
  finished: Finished[];
  runner: { reportedAt: string | null; stale: boolean };
}

/** The user's tasks a run works on: a routine run names them in its description, any other run is on one. */
export function runTasks(issue: Pick<Issue, "identifier" | "title" | "description" | "originKind">, prefix: string): TaskRef[] {
  if (issue.originKind !== "routine_execution") return [{ identifier: issue.identifier, title: issue.title }];
  if (!prefix) return [];
  const re = new RegExp(`\\b${prefix.replace(/[^A-Z0-9]/g, "")}-\\d{1,7}\\b`, "g");
  return [...new Set((issue.description ?? "").match(re) ?? [])].filter((r) => r !== issue.identifier).map((identifier) => ({ identifier }));
}

export interface RunContext {
  run: TaskRef | null;
  tasks: TaskRef[];
  /** Who the run's task is assigned to: tells which Engineer a queued runner job is for. */
  assigneeAgentId?: string | null;
}

const isLive = (status: string) => status === "running" || status === "queued";

/** Assemble the view from runs already resolved to their tasks (`resolve`). */
export async function agentsView(input: {
  live: LiveRun[];
  past: PastRun[];
  runner: RunnerReport | undefined;
  agents: Agent[];
  resolve: (issueId: string | null) => Promise<RunContext>;
  now?: number;
}): Promise<AgentsView> {
  const now = input.now ?? Date.now();
  const name = (id: string, fallback?: string) => input.agents.find((a) => a.id === id)?.name ?? fallback ?? "Agent";
  const sessions: Session[] = [];
  for (const r of input.live) {
    const { run, tasks } = await input.resolve(r.issueId);
    sessions.push({
      id: r.id,
      source: "agent",
      agent: name(r.agentId, r.agentName),
      agentId: r.agentId,
      state: r.status === "queued" ? "queued" : "working",
      startedAt: r.startedAt ?? r.createdAt,
      doing: r.currentStatusMessage ?? undefined,
      tool: r.currentToolName ?? undefined,
      said: r.lastAssistantSnippet ? r.lastAssistantSnippet.slice(0, 400) : undefined,
      quiet: r.outputSilence?.level !== undefined && r.outputSilence.level !== "ok",
      run,
      tasks,
    });
  }
  const runner = input.runner;
  const fresh = runner && now - Date.parse(runner.at) < RUNNER_STALE_MS ? runner : undefined;
  const ref = (j: { identifier: string }) => ({ run: { identifier: j.identifier }, tasks: [{ identifier: j.identifier }] });
  for (const j of fresh?.running ?? []) {
    sessions.push({ id: `runner:${j.issueId}`, source: "runner", agent: engineerName(j), agentId: engineerOf(j.engine, input.agents), state: "working", startedAt: j.startedAt, doing: jobDoing(j), ...ref(j) });
  }
  for (const j of fresh?.queued ?? []) {
    const agentId = (await input.resolve(j.issueId)).assigneeAgentId ?? null;
    sessions.push({ id: `runner:queued:${j.issueId}`, source: "runner", agent: (agentId && name(agentId, "Engineer")) || "Engineer", agentId, state: "queued", startedAt: null, doing: "Waiting for a free slot", ...ref(j) });
  }

  const finished: Finished[] = [];
  for (const r of input.past) {
    if (isLive(r.status) || !r.finishedAt || now - Date.parse(r.finishedAt) > FINISHED_WINDOW_MS) continue;
    const { run, tasks } = await input.resolve(r.issueId);
    finished.push({ id: r.id, source: "agent", agent: name(r.agentId), agentId: r.agentId, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, detail: r.error ?? undefined, run, tasks });
  }
  for (const j of runner?.recent ?? []) {
    if (!j.finishedAt || now - Date.parse(j.finishedAt) > FINISHED_WINDOW_MS) continue;
    finished.push({ id: `runner:${j.issueId}:${j.startedAt}`, source: "runner", agent: engineerName(j), agentId: engineerOf(j.engine, input.agents), status: j.status ?? "finished", startedAt: j.startedAt, finishedAt: j.finishedAt, detail: jobDoing(j), ...ref(j) });
  }
  finished.sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
  return { sessions, finished: finished.slice(0, 25), runner: { reportedAt: runner?.at ?? null, stale: !fresh } };
}

/** Which of the user's tasks have an agent working on them, by identifier. */
export function workingOn(sessions: Session[]): Map<string, { agent: string; since: string | null; queued: boolean }> {
  const out = new Map<string, { agent: string; since: string | null; queued: boolean }>();
  for (const s of sessions) {
    for (const t of s.tasks) {
      const prev = out.get(t.identifier);
      if (!prev || (prev.queued && s.state === "working")) out.set(t.identifier, { agent: s.agent, since: s.startedAt, queued: s.state === "queued" });
    }
  }
  return out;
}

/** The Engineer for a runner job, from the engine label it reports ("Claude Code (opus)", "Codex", "OpenRouter …"). */
const LABEL_ADAPTER: [RegExp, string][] = [[/^Codex\b/, "codex_local"], [/^Claude Code\b/, "claude_local"], [/^OpenRouter\b/, "opencode_local"]];
function engineerOf(label: string | undefined, agents: Agent[]): string | null {
  const adapter = LABEL_ADAPTER.find(([re]) => re.test(label ?? ""))?.[1];
  const agent = adapter && agents.find((a) => a.adapterType === adapter && /^pennyworth:engineer(-|$)/.test(a.metadata?.setupKey ?? "") && a.status !== "terminated");
  return agent ? agent.id : null;
}

const engineerName = (j: RunnerJob) => (j.engine ? `Engineer · ${j.engine}` : "Engineer");
const jobDoing = (j: RunnerJob) => [j.mode && j.mode[0]!.toUpperCase() + j.mode.slice(1), j.repo].filter(Boolean).join(" in ") || undefined;
