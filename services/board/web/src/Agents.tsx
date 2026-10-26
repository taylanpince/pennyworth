import { useCallback, useEffect, useState } from "react";
import { PairRequired, api } from "./api";
import { Avatar } from "./components";
import type { Agents, Assignee, Finished, Session, TaskRef } from "./types";
import { ago, elapsed } from "./util";

const STATUS: Record<string, { text: string; tone: "ok" | "bad" | "meh" }> = {
  succeeded: { text: "Done", tone: "ok" },
  done: { text: "Done", tone: "ok" },
  failed: { text: "Failed", tone: "bad" },
  error: { text: "Failed", tone: "bad" },
  timed_out: { text: "Timed out", tone: "bad" },
  timeout: { text: "Timed out", tone: "bad" },
  cancelled: { text: "Stopped", tone: "meh" },
  incomplete: { text: "Unfinished", tone: "meh" },
  interrupted: { text: "Interrupted", tone: "meh" },
};

/**
 * The board's other view (D-34, D-45): the crew you assign work to, one tile each with what they're on,
 * their queue and what they finished lately; then the background agents' runs (scans, briefs).
 */
export function CrewView({ query, crew, onPairing }: { query: string; crew: Assignee[]; onPairing: () => void }) {
  const [data, setData] = useState<Agents | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [scans, setScans] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.agents());
      setError("");
    } catch (e) {
      if (e instanceof PairRequired) onPairing();
      else setError((e as Error).message);
    }
  }, [onPairing]);

  useEffect(() => {
    void load();
    const poll = setInterval(() => document.visibilityState === "visible" && void load(), 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => (clearInterval(poll), clearInterval(tick));
  }, [load]);

  if (!data) return <main className="agents">{error ? <p className="empty">Couldn't load agent activity: {error}</p> : <span className="spinner" />}</main>;

  const match = (x: { agent: string; run: TaskRef | null; tasks: TaskRef[] }) => {
    if (!query) return true;
    const hay = [x.agent, x.run?.identifier, x.run?.title, ...x.tasks.flatMap((t) => [t.identifier, t.title])].join(" ").toLowerCase();
    return query.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  };
  const members = crew.filter((a) => a.kind !== "me");
  const isCrew = (x: { agentId: string | null }) => members.some((m) => m.key === x.agentId);
  const working = data.sessions.filter((s) => s.state === "working" && !isCrew(s) && match(s));
  const queued = data.sessions.filter((s) => s.state === "queued" && !isCrew(s) && match(s));
  // Scans and other runs that touched none of your tasks only on request: they'd bury the rest.
  const finishedAll = data.finished.filter((f) => !isCrew(f) && match(f));
  const finished = scans ? finishedAll : finishedAll.filter((f) => f.tasks.length);
  const hiddenScans = finishedAll.length - finished.length;

  return (
    <main className="agents">
      {error && <div className="offline">Offline: {error}. Retrying…</div>}
      {data.runner.stale && (
        <p className="agents-note">
          {data.runner.reportedAt ? `The runner last reported ${ago(data.runner.reportedAt, now)} ago, so Engineer jobs may be missing.` : "The runner hasn't reported yet, so Engineer jobs aren't shown."}
        </p>
      )}
      <div className="crew-tiles">
        {members.map((m) => (
          <CrewTile key={m.key} member={m} sessions={data.sessions.filter((s) => s.agentId === m.key && match(s))} finished={data.finished.filter((f) => f.agentId === m.key && f.tasks.length && match(f))} now={now} />
        ))}
      </div>
      <section>
        <header className="agents-head">
          <h2>Background</h2>
          <span className="count">{working.length}</span>
          <span className="hint">Scouts, the brief and meeting notes bring work in</span>
        </header>
        {working.map((s) => (
          <SessionRow key={s.id} s={s} now={now} />
        ))}
        {!working.length && <p className="empty">Nothing running in the background.</p>}
      </section>
      {queued.length > 0 && (
        <section>
          <header className="agents-head">
            <h2>Queued</h2>
            <span className="count">{queued.length}</span>
          </header>
          {queued.map((s) => (
            <SessionRow key={s.id} s={s} now={now} />
          ))}
        </section>
      )}
      <section>
        <header className="agents-head">
          <h2>Finished recently</h2>
          <span className="hint">Last 12 hours</span>
          <span className="spacer" />
          {(hiddenScans > 0 || scans) && (
            <button className={`tag toggle${scans ? " on" : ""}`} onClick={() => setScans(!scans)}>
              {scans ? "Hide scans" : `Show scans (${hiddenScans})`}
            </button>
          )}
        </header>
        {finished.map((f) => (
          <FinishedRow key={f.id} f={f} now={now} />
        ))}
        {!finished.length && <p className="empty">{hiddenScans ? "No work on your tasks finished lately; only scans." : "Nothing finished lately."}</p>}
      </section>
    </main>
  );
}

const ENGINE_NAMES: Record<string, string> = { codex: "Codex", claude: "Claude Code", openrouter: "OpenRouter" };

function role(m: Assignee): string {
  if (m.kind === "assistant") return "Assistant · research and drafts";
  const model = m.defaultModel?.replace(/^openrouter\//, "");
  return `Engineer · ${ENGINE_NAMES[m.engine ?? ""] ?? m.name}${model ? ` · ${model}` : ""}`;
}

/** One crew member: who they are, what they're on now, their queue, and what they finished lately. */
function CrewTile({ member, sessions, finished, now }: { member: Assignee; sessions: Session[]; finished: Finished[]; now: number }) {
  const on = sessions.filter((s) => s.state === "working");
  const queued = sessions.filter((s) => s.state === "queued");
  return (
    <section className={`crew-tile${on.length ? " busy" : ""}`}>
      <header className="crew-head">
        <span className="crew-portrait">
          <Avatar assignee={member} size={52} />
        </span>
        <div>
          <h2>{member.persona?.name ?? member.name}</h2>
          <div className="muted small">{role(member)}</div>
        </div>
      </header>
      {member.persona?.voice && <p className="crew-voice">{member.persona.voice}</p>}
      <h3>On it now{on.length ? ` · ${on.length}` : ""}</h3>
      {on.map((s) => (
        <div key={s.id} className="crew-job">
          <Tasks tasks={s.tasks} fallback={s.run} />
          <div className="session-doing">
            {[s.doing, s.tool && `tool: ${s.tool}`].filter(Boolean).join(" · ")}
            {s.startedAt && <span className="time"> · {elapsed(s.startedAt, now)}</span>}
          </div>
          {s.quiet && <div className="session-doing warn">No output for a while.</div>}
          {s.said && <div className="session-said">{s.said}</div>}
        </div>
      ))}
      {!on.length && <p className="empty">Free</p>}
      {queued.length > 0 && (
        <>
          <h3>Queued · {queued.length}</h3>
          {queued.map((s) => (
            <Tasks key={s.id} tasks={s.tasks} fallback={s.run} />
          ))}
        </>
      )}
      {finished.length > 0 && (
        <>
          <h3>Finished lately</h3>
          {finished.slice(0, 5).map((f) => {
            const st = STATUS[f.status] ?? { text: f.status, tone: "meh" as const };
            return (
              <div key={f.id} className="crew-done" title={f.detail}>
                <span className={`run-status run-${st.tone}`}>{st.text}</span>
                <Tasks tasks={f.tasks} fallback={f.run} inline />
                <span className="spacer" />
                <span className="time">{f.finishedAt ? ago(f.finishedAt, now) : ""}</span>
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}

function SessionRow({ s, now }: { s: Session; now: number }) {
  const routine = s.run && !s.tasks.some((t) => t.identifier === s.run!.identifier);
  return (
    <div className={`session${s.state === "queued" ? " queued" : ""}`}>
      <div className="session-head">
        <span className={s.state === "queued" ? "queued-dot" : "live-dot"} />
        <b>{s.agent}</b>
        <span className="spacer" />
        {s.startedAt && (
          <span className="time" title={`Started ${new Date(s.startedAt).toLocaleString()}`}>
            {elapsed(s.startedAt, now)}
          </span>
        )}
      </div>
      <Tasks tasks={s.tasks} fallback={s.run} />
      {(s.doing || s.tool || routine) && (
        <div className="session-doing">
          {[s.doing, s.tool && `tool: ${s.tool}`].filter(Boolean).join(" · ")}
          {routine && s.tasks.length > 0 && (
            <>
              {s.doing || s.tool ? " · " : ""}via <a href={`#/t/${s.run!.identifier}`}>{s.run!.title ?? s.run!.identifier}</a>
            </>
          )}
        </div>
      )}
      {s.quiet && <div className="session-doing warn">No output for a while.</div>}
      {s.said && <div className="session-said">{s.said}</div>}
    </div>
  );
}

function FinishedRow({ f, now }: { f: Finished; now: number }) {
  const st = STATUS[f.status] ?? { text: f.status, tone: "meh" as const };
  const took = f.startedAt && f.finishedAt ? elapsed(f.startedAt, Date.parse(f.finishedAt)) : undefined;
  return (
    <div className="finished" title={f.detail}>
      <span className={`run-status run-${st.tone}`}>{st.text}</span>
      <span className="finished-agent">{f.agent}</span>
      <Tasks tasks={f.tasks} fallback={f.run} inline />
      <span className="spacer" />
      <span className="time">
        {took && <>{took} · </>}
        {f.finishedAt ? ago(f.finishedAt, now) : ""}
      </span>
    </div>
  );
}

/** The user's tasks a run works on, or the run's own task (a scan) when it names none. */
function Tasks({ tasks, fallback, inline }: { tasks: TaskRef[]; fallback: TaskRef | null; inline?: boolean }) {
  const list = tasks.length ? tasks : fallback ? [fallback] : [];
  if (!list.length) return null;
  return (
    <span className={inline ? "task-links inline" : "task-links"}>
      {list.map((t) => (
        <a key={t.identifier} className="task-link" href={`#/t/${t.identifier}`}>
          <span className="ident">{t.identifier}</span>
          {t.title && <span className="task-title">{t.title}</span>}
        </a>
      ))}
    </span>
  );
}
