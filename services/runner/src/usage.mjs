import { readFile } from "node:fs/promises";
import { stripHidden } from "./commands.mjs";

/**
 * What a job used, read from its engine's event stream (the job log): tokens, cost, tools, subagents.
 *
 * Claude Code and Codex report a *session's* running totals, not the run's: `total_cost_usd` and
 * `modelUsage` on Claude Code's `result` events, and `usage` on Codex's `turn.completed`, climb job
 * after job while a session is resumed (and, with streamed input, across the results of one job). A
 * job's share is its last totals minus the session's totals at the end of its previous job
 * (`previousSession`), or the whole of them for a new session or when they went down. Summing the
 * raw values counted a long session's early turns once per job (D-62). opencode reports each step's
 * own tokens and cost, which add up.
 *
 * Token fields: `inputTokens` is uncached input, `cacheReadTokens` and `cacheWriteTokens` the cached
 * part, `outputTokens` includes `reasoningTokens` (thinking). `costUsd` is null when the engine
 * reports none (Codex, on a subscription) or the run never got as far as reporting; Claude Code's is
 * its list-price estimate. `turns` counts model round trips where the engine says (Claude Code's
 * `num_turns`, opencode's steps) and turns for Codex. `contextTokens` is the last request's input,
 * where the engine reports it (not Codex).
 */

const MCP_SERVERS = ["primer", "grafana", "slack", "glean", "clickhouse"];
const TOKEN_FIELDS = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens"];

const n = (v) => (Number.isFinite(v) ? v : 0);
const zero = () => Object.fromEntries(TOKEN_FIELDS.map((k) => [k, 0]));

/** Claude Code's session totals from a result event (modelUsage sums every model, subagents included). */
function claudeTotals(e) {
  const models = Object.values(e.modelUsage ?? {});
  if (!models.length) return undefined;
  const sum = (k) => models.reduce((a, m) => a + n(m[k]), 0);
  return {
    inputTokens: sum("inputTokens"),
    cacheReadTokens: sum("cacheReadInputTokens"),
    cacheWriteTokens: sum("cacheCreationInputTokens"),
    outputTokens: sum("outputTokens"),
    reasoningTokens: sum("thinkingTokens"),
    costUsd: Number.isFinite(e.total_cost_usd) ? e.total_cost_usd : sum("costUSD"),
  };
}

/** Codex's thread totals from turn.completed: its input_tokens include the cached part. */
function codexTotals(u) {
  return {
    inputTokens: Math.max(0, n(u.input_tokens) - n(u.cached_input_tokens)),
    cacheReadTokens: n(u.cached_input_tokens),
    cacheWriteTokens: n(u.cache_write_input_tokens),
    outputTokens: n(u.output_tokens),
    reasoningTokens: n(u.reasoning_output_tokens),
    costUsd: null,
  };
}

/** `mcp__server__tool` → server (Codex's and opencode's MCP calls are named the same way here). */
const mcpServer = (name) => /^mcp__(.+?)__/.exec(name)?.[1];

/** Accumulates a run's events as they come; `finish` turns them into the job's usage. */
export function usageTracker(engine) {
  let sessionId;
  let totals; // Claude Code / Codex: the session's running totals at the latest report
  const own = zero(); // what the run itself reported per step or turn (opencode; Claude Code without modelUsage)
  let ownCost = 0;
  let costSeen = false;
  let turns = 0;
  let subagents = 0;
  let agentCalls = 0;
  let context = 0;
  const tools = {};
  const mcp = {};
  const seen = new Set();
  const tool = (name) => {
    if (!name) return;
    tools[name] = (tools[name] ?? 0) + 1;
    const server = mcpServer(name);
    if (server) mcp[server] = (mcp[server] ?? 0) + 1;
  };

  function take(e) {
    if (!e || typeof e !== "object") return;
    if (engine === "claude") {
      if (e.type === "system" && e.subtype === "init" && e.session_id) sessionId ??= e.session_id;
      if (e.type === "assistant") {
        for (const c of e.message?.content ?? []) {
          if (c?.type !== "tool_use" || seen.has(c.id)) continue;
          if (c.id) seen.add(c.id);
          tool(c.name);
          if (c.name === "Agent" || c.name === "Task") agentCalls++;
        }
      }
      if (e.type === "result") {
        if (e.session_id) sessionId = e.session_id;
        turns += n(e.num_turns);
        // Spawned subagents: a running count for the process, so the largest one is the run's.
        subagents = Math.max(subagents, n(e.subagent_stats?.spawned));
        const t = claudeTotals(e);
        if (t) totals = t;
        else if (e.usage) {
          own.inputTokens += n(e.usage.input_tokens);
          own.cacheReadTokens += n(e.usage.cache_read_input_tokens);
          own.cacheWriteTokens += n(e.usage.cache_creation_input_tokens);
          own.outputTokens += n(e.usage.output_tokens);
          own.reasoningTokens += n(e.usage.output_tokens_details?.thinking_tokens);
          if (Number.isFinite(e.total_cost_usd)) (ownCost = e.total_cost_usd), (costSeen = true);
        }
        const last = Array.isArray(e.usage?.iterations) && e.usage.iterations.length ? e.usage.iterations.at(-1) : undefined;
        if (last) context = n(last.input_tokens) + n(last.cache_read_input_tokens) + n(last.cache_creation_input_tokens);
      }
    } else if (engine === "codex") {
      if (e.type === "thread.started" && e.thread_id) sessionId ??= e.thread_id;
      if (e.type === "turn.completed") {
        turns++;
        if (e.usage) totals = codexTotals(e.usage);
      }
      if (e.type === "item.completed" && e.item) {
        const it = e.item;
        if (it.type === "mcp_tool_call") tool(`mcp__${it.server}__${it.tool}`);
        else if (it.type === "command_execution") tool("command");
        else if (it.type === "file_change" || it.type === "web_search") tool(it.type);
      }
    } else if (engine === "openrouter") {
      if (e.sessionID) sessionId ??= e.sessionID;
      if (e.type === "tool_use" && e.part?.tool) {
        const name = e.part.tool;
        const server = MCP_SERVERS.find((s) => name.startsWith(`${s}_`));
        tool(server ? `mcp__${server}__${name.slice(server.length + 1)}` : name);
        if (name === "task") agentCalls++;
      }
      if (e.type === "step_finish" && e.part) {
        turns++;
        const t = e.part.tokens ?? {};
        own.inputTokens += n(t.input);
        own.cacheReadTokens += n(t.cache?.read);
        own.cacheWriteTokens += n(t.cache?.write);
        own.outputTokens += n(t.output) + n(t.reasoning); // opencode counts reasoning apart
        own.reasoningTokens += n(t.reasoning);
        if (Number.isFinite(e.part.cost)) (ownCost += e.part.cost), (costSeen = true);
        context = n(t.input) + n(t.cache?.read) + n(t.cache?.write);
      }
    }
  }

  /**
   * The job's usage. `previousSession`: the session's totals after its previous job (an object, or a
   * function of the session ID), from `sessionAfter` of that job.
   */
  function finish({ previousSession } = {}) {
    let tokens = own;
    let costUsd = costSeen ? ownCost : null;
    let sessionAfter;
    if (totals) {
      sessionAfter = { ...totals };
      const prev = typeof previousSession === "function" ? (sessionId ? previousSession(sessionId) : undefined) : previousSession;
      // A new session, or totals that went down (not the same session after all): the whole of them.
      const continues = prev && TOKEN_FIELDS.every((k) => totals[k] >= n(prev[k])) && (totals.costUsd == null || prev.costUsd == null || totals.costUsd >= prev.costUsd);
      tokens = Object.fromEntries(TOKEN_FIELDS.map((k) => [k, totals[k] - (continues ? n(prev[k]) : 0)]));
      costUsd = totals.costUsd == null ? null : round(totals.costUsd - (continues && Number.isFinite(prev.costUsd) ? prev.costUsd : 0));
    } else if (costUsd != null) costUsd = round(costUsd);
    return {
      ...tokens,
      costUsd,
      sessionId: sessionId ?? null,
      sessionCostAfter: sessionAfter?.costUsd ?? null,
      sessionAfter: sessionAfter ?? null,
      contextTokens: context,
      turns,
      subagents: Math.max(subagents, agentCalls),
      tools,
      mcp,
    };
  }

  return { take, finish };
}

const round = (v) => Math.round(v * 1e6) / 1e6;

/** Usage from a job's log lines (engine events; header and stderr lines are skipped). */
export function usageFromEvents(lines, { engine, previousSession } = {}) {
  const tracker = usageTracker(engine);
  for (const line of lines) {
    if (!line || line[0] !== "{") continue;
    try {
      tracker.take(JSON.parse(line));
    } catch {
      /* not an event */
    }
  }
  return tracker.finish({ previousSession });
}

/** A job log's header: `# <ISO> <engine kind> (<model>) in <workspace>`. */
export function logHeader(text) {
  const m = /^# (\S+) (codex|claude|openrouter)(?: \(([^)]*)\))? in /.exec(String(text).split("\n", 1)[0]);
  return m ? { at: m[1], kind: m[2], model: m[3] ?? null } : undefined;
}

/** Read a job log: its header and usage. Undefined when the log is missing or not an engine run. */
export async function usageFromLog(path, { engine, previousSession } = {}) {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const header = logHeader(text);
  const kind = engine ?? header?.kind;
  if (!kind) return undefined;
  return { header, usage: usageFromEvents(text.split("\n"), { engine: kind, previousSession }) };
}

/** The engine kind from the label stored on a job ("Claude Code (…)", "Codex (…)", "OpenRouter …"). */
export function engineKind(label) {
  const s = String(label ?? "");
  return s.startsWith("Claude") ? "claude" : s.startsWith("Codex") ? "codex" : s.startsWith("OpenRouter") ? "openrouter" : undefined;
}

/**
 * A short request to do the same again ("try again", "please run it again", "retry"): deterministic,
 * on the request's visible text, under 80 characters.
 */
const RETRY = /^(please\s+)?(try|check|run|publish|push|do)\s+(it\s+|that\s+)?again\b|^retry\b|^again[.!]*$/i;
export function isRetry(instructions) {
  const text = stripHidden(instructions).trim();
  return text.length > 0 && text.length < 80 && RETRY.test(text);
}

/** The board's JobUsage for a stored job (state's jobs row joined with its task's identifier). */
export function jobUsage(row) {
  const u = row.usage_json ? JSON.parse(row.usage_json) : {};
  return {
    id: row.id,
    issueId: row.issue_id,
    identifier: row.identifier,
    agentId: row.agent_id ?? null,
    engine: engineKind(row.engine) ?? "claude",
    engineLabel: row.engine ?? "",
    model: row.model ?? null,
    effort: row.effort ?? null,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    resumed: Boolean(row.resumed),
    restarted: Boolean(row.restarted),
    retry: Boolean(row.retry),
    inputTokens: n(u.inputTokens),
    cacheReadTokens: n(u.cacheReadTokens),
    cacheWriteTokens: n(u.cacheWriteTokens),
    outputTokens: n(u.outputTokens),
    reasoningTokens: n(u.reasoningTokens),
    costUsd: Number.isFinite(u.costUsd) ? u.costUsd : null,
    contextTokens: n(u.contextTokens),
    turns: n(u.turns),
    subagents: n(u.subagents),
    tools: u.tools ?? {},
    mcp: u.mcp ?? {},
  };
}
