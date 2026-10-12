import { useCallback, useEffect, useState } from "react";
import { PairRequired, api } from "./api";
import type { Agents, Finished, Session, TaskRef } from "./types";
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

/** The board's other view: which agents are running now, on which tasks, and what finished lately. */
export function AgentsView({ query, onPairing }: { query: string; onPairing: () => void }) {
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
  const working = data.sessions.filter((s) => s.state === "working" && match(s));
  const queued = data.sessions.filter((s) => s.state === "queued" && match(s));
  // Scans and other runs that touched none of your tasks only on request: they'd bury the rest.
  const finishedAll = data.finished.filter(match);
  const finished = scans ? finishedAll : finishedAll.filter((f) => f.tasks.length);
  const hiddenScans = finishedAll.length - finished.length;

  return (
    <main className="agents">
      {error && <div className="offline">Offline: {error}. Retrying…</div>}
      <section>
        <header className="agents-head">
          <h2>Working now</h2>
          <span className="count">{working.length}</span>
        </header>
        {data.runner.stale && (
          <p className="agents-note">
            {data.runner.reportedAt ? `The runner last reported ${ago(data.runner.reportedAt, now)} ago, so Engineer jobs may be missing.` : "The runner hasn't reported yet, so Engineer jobs aren't shown."}
          </p>
        )}
        {working.map((s) => (
          <SessionRow key={s.id} s={s} now={now} />
        ))}
        {!working.length && <p className="empty">No agent is working right now.</p>}
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
