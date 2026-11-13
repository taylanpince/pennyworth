import { useCallback, useEffect, useState } from "react";
import { PairRequired, memoryApi } from "./api";
import type { Episode, Memory, MemoryBudget, MemoryKind, MemoryList, MemoryPatch, MemoryScope } from "./types";
import { ago } from "./util";

// The Memory view (D-61): what the agents keep from the user's word. Proposals to review first, then the
// rules for everyone and each crew member's own, then past tasks to find earlier work by.

const KINDS: MemoryKind[] = ["rule", "fact", "lesson", "playbook"];
const KIND_HINTS: Record<MemoryKind, string> = {
  rule: "Always or never: applies to every task",
  fact: "Something true: teams, names, where things are",
  lesson: "Learned from a correction",
  playbook: "Steps for a procedure, one per line",
};
const LIMITS: Record<MemoryKind, number> = { rule: 600, fact: 600, lesson: 600, playbook: 4000 };
const STALE_MS = 30 * 86_400_000;

/** Proposals waiting for the user, for the nav badge: polled while the page is visible. */
export function useMemoryPending(refreshKey = 0): number {
  const [pending, setPending] = useState(0);
  useEffect(() => {
    const load = () => document.visibilityState === "visible" && void memoryApi.pending().then((r) => setPending(r.pending), () => {});
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [refreshKey]);
  return pending;
}

function Portrait({ scope, size = 28 }: { scope: MemoryScope | undefined; size?: number }) {
  const style = { width: size, height: size };
  if (scope?.avatar) return <img className="avatar portrait" src={`/crew/${scope.avatar}.svg`} alt="" title={scope.name} style={style} draggable={false} />;
  return (
    <span className={`avatar ${scope?.scope === "global" ? "avatar-me" : "avatar-assistant"}`} style={style} title={scope?.name}>
      {scope?.scope === "global" ? "∗" : (scope?.name ?? "?").slice(0, 1).toUpperCase()}
    </span>
  );
}

const matchesQuery = (m: Memory, query: string, scopes: MemoryScope[]) => {
  if (!query.trim()) return true;
  const hay = [m.text, m.why, m.kind, m.sourceIssue, m.createdBy, scopes.find((s) => s.scope === m.scope)?.name].join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};

export function MemoryView({ query, onPairing, onChanged }: { query: string; onPairing: () => void; onChanged?: () => void }) {
  const [data, setData] = useState<MemoryList | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"memories" | "past">("memories");
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await memoryApi.list());
      setError("");
    } catch (e) {
      if (e instanceof PairRequired) onPairing();
      else setError((e as Error).message);
    }
  }, [onPairing]);

  useEffect(() => {
    void load();
    const poll = setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
    return () => clearInterval(poll);
  }, [load]);

  /** A change, then the list again; a refusal (too long, looks like a secret) shows as the error. */
  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        setError("");
        await load();
        onChanged?.();
        return true;
      } catch (e) {
        if (e instanceof PairRequired) onPairing();
        else setError((e as Error).message);
        return false;
      }
    },
    [load, onChanged, onPairing],
  );

  if (!data) return <main className="agents memory">{error ? <p className="empty">Couldn't load memory: {error}</p> : <span className="spinner" />}</main>;

  const scopes = data.scopes;
  const proposals = data.memories.filter((m) => m.status === "proposed" && matchesQuery(m, query, scopes));
  const archivedCount = data.memories.filter((m) => m.status === "archived" || m.status === "rejected").length;

  return (
    <main className="agents memory">
      <nav className="memory-tabs">
        <button className={tab === "memories" ? "on" : ""} onClick={() => setTab("memories")}>
          Memories
          {data.pending > 0 && <span className="btn-count needs">{data.pending}</span>}
        </button>
        <button className={tab === "past" ? "on" : ""} onClick={() => setTab("past")}>
          Past tasks
        </button>
        <span className="spacer" />
        {tab === "memories" && archivedCount > 0 && (
          <button className={`tag toggle${showArchived ? " on" : ""}`} onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
          </button>
        )}
      </nav>
      {error && <div className="alert">{error}</div>}
      {tab === "past" ? (
        <PastTasks query={query} scopes={scopes} />
      ) : (
        <>
          {proposals.length > 0 && (
            <section>
              <header className="agents-head">
                <h2>To review</h2>
                <span className="count">{proposals.length}</span>
                <span className="hint">The agents suggest these; nothing is used until you accept it</span>
              </header>
              {proposals.map((m) => (
                <Proposal key={m.id} m={m} scopes={scopes} act={act} />
              ))}
            </section>
          )}
          {scopes.map((s) => (
            <ScopeSection
              key={s.scope}
              scope={s}
              scopes={scopes}
              budget={data.budgets[s.scope]}
              memories={data.memories.filter((m) => m.scope === s.scope && (m.status === "active" || (showArchived && (m.status === "archived" || m.status === "rejected"))) && matchesQuery(m, query, scopes))}
              filtered={Boolean(query.trim())}
              act={act}
            />
          ))}
        </>
      )}
    </main>
  );
}

type Act = (fn: () => Promise<unknown>) => Promise<boolean>;

function KindSelect({ value, onChange }: { value: MemoryKind; onChange: (k: MemoryKind) => void }) {
  return (
    <select className={`mem-kind kind-${value}`} value={value} onChange={(e) => onChange(e.target.value as MemoryKind)} title={KIND_HINTS[value]} aria-label="Kind">
      {KINDS.map((k) => (
        <option key={k} value={k}>
          {k}
        </option>
      ))}
    </select>
  );
}

function ScopeSelect({ value, scopes, onChange, label = "Move to" }: { value: string; scopes: MemoryScope[]; onChange: (s: string) => void; label?: string }) {
  return (
    <select className="mem-scope" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} title={label}>
      {scopes.map((s) => (
        <option key={s.scope} value={s.scope}>
          {s.scope === "global" ? "Everyone" : s.name}
        </option>
      ))}
    </select>
  );
}

/** Text with a character count against the kind's limit. */
function Editor({ text, kind, onText, autoFocus }: { text: string; kind: MemoryKind; onText: (t: string) => void; autoFocus?: boolean }) {
  const over = text.trim().length > LIMITS[kind];
  return (
    <div className="mem-editor">
      <textarea value={text} onChange={(e) => onText(e.target.value)} rows={kind === "playbook" ? 7 : 3} autoFocus={autoFocus} placeholder={KIND_HINTS[kind]} />
      <span className={`small ${over ? "mem-over" : "muted"}`}>
        {text.trim().length} / {LIMITS[kind]}
      </span>
    </div>
  );
}

function Proposal({ m, scopes, act }: { m: Memory; scopes: MemoryScope[]; act: Act }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.text);
  const [kind, setKind] = useState(m.kind);
  const [scope, setScope] = useState(m.scope);
  const by = scopes.find((s) => s.name === m.createdBy) ?? scopes.find((s) => s.scope === m.scope);
  const target = scopes.find((s) => s.scope === m.scope);
  return (
    <div className="mem-card proposal">
      <div className="mem-head">
        <Portrait scope={by} />
        <span>
          <b>{m.createdBy ?? by?.name ?? "An agent"}</b> {m.origin === "remember" ? "was asked to remember" : "suggests"}, for <b>{m.scope === "global" ? "everyone" : target?.name ?? m.scope}</b>
        </span>
        <span className="spacer" />
        {!editing && <span className={`mem-kind kind-${m.kind}`}>{m.kind}</span>}
      </div>
      {editing ? (
        <>
          <Editor text={text} kind={kind} onText={setText} autoFocus />
          <div className="mem-actions">
            <KindSelect value={kind} onChange={setKind} />
            <ScopeSelect value={scope} scopes={scopes} onChange={setScope} label="For" />
          </div>
        </>
      ) : (
        <p className="mem-text">{m.text}</p>
      )}
      {m.why && <p className="mem-why">Why: {m.why}</p>}
      <div className="mem-actions">
        {m.sourceIssue && (
          <a className="task-link" href={`#/t/${m.sourceIssue}`}>
            <span className="ident">{m.sourceIssue}</span>
          </a>
        )}
        <span className="muted small">{ago(m.createdAt)}</span>
        <span className="spacer" />
        {editing ? (
          <>
            <button className="btn" onClick={() => (setEditing(false), setText(m.text), setKind(m.kind), setScope(m.scope))}>
              Cancel
            </button>
            <button className="btn primary" disabled={!text.trim() || text.trim().length > LIMITS[kind]} onClick={() => void act(() => memoryApi.accept(m.id, { text, kind, scope }))}>
              Save and accept
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => void act(() => memoryApi.reject(m.id))}>
              Reject
            </button>
            <button className="btn" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className="btn primary" onClick={() => void act(() => memoryApi.accept(m.id))}>
              Accept
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ScopeSection({ scope, scopes, budget, memories, filtered, act }: { scope: MemoryScope; scopes: MemoryScope[]; budget: MemoryBudget | undefined; memories: Memory[]; filtered: boolean; act: Act }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<MemoryKind>(scope.scope === "global" ? "rule" : "lesson");
  if (filtered && !memories.length) return null;
  const omitted = new Set(budget?.omitted ?? []);
  const save = async () => {
    if (await act(() => memoryApi.add({ scope: scope.scope, kind, text }))) (setAdding(false), setText(""));
  };
  return (
    <section className="mem-section">
      <header className="mem-section-head">
        <Portrait scope={scope} size={34} />
        <div>
          <h2>{scope.scope === "global" ? "Everyone" : scope.name}</h2>
          <div className="muted small">{scope.scope === "global" ? "Rules and facts every agent follows" : `${scope.name}'s own lessons and playbooks`}</div>
        </div>
        <span className="spacer" />
        {budget && (
          <span className="mem-budget" title="What the agent gets at the start of every task; the rest is a search away">
            <progress max={budget.budget} value={Math.min(budget.used, budget.budget)} />
            <span className="small muted">
              {budget.used.toLocaleString()} / {budget.budget.toLocaleString()}
              {budget.omitted.length > 0 && <b className="mem-over"> · {budget.omitted.length} left out</b>}
            </span>
          </span>
        )}
        <button className="btn" onClick={() => setAdding(!adding)}>
          + Add
        </button>
      </header>
      {adding && (
        <div className="mem-card">
          <Editor text={text} kind={kind} onText={setText} autoFocus />
          <div className="mem-actions">
            <KindSelect value={kind} onChange={setKind} />
            <span className="muted small">{KIND_HINTS[kind]}</span>
            <span className="spacer" />
            <button className="btn" onClick={() => (setAdding(false), setText(""))}>
              Cancel
            </button>
            <button className="btn primary" disabled={!text.trim() || text.trim().length > LIMITS[kind]} onClick={() => void save()}>
              Save
            </button>
          </div>
        </div>
      )}
      {memories.map((m) => (
        <MemoryRow key={m.id} m={m} scopes={scopes} leftOut={omitted.has(m.id)} act={act} />
      ))}
      {!memories.length && !adding && <p className="empty">Nothing yet. {scope.scope === "global" ? "Tell any agent to remember something, or add it here." : `Tell ${scope.name} to remember something, or add it here.`}</p>}
    </section>
  );
}

function MemoryRow({ m, scopes, leftOut, act }: { m: Memory; scopes: MemoryScope[]; leftOut: boolean; act: Act }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.text);
  useEffect(() => setText(m.text), [m.text]);
  const update = (patch: MemoryPatch) => act(() => memoryApi.update(m.id, patch));
  const closed = m.status !== "active";
  const stale = !closed && Date.now() - Date.parse(m.lastUsedAt ?? m.decidedAt ?? m.createdAt) > STALE_MS;
  return (
    <div className={`mem-card${closed ? " closed" : ""}${m.pinned ? " pinned" : ""}`}>
      {editing ? (
        <>
          <Editor text={text} kind={m.kind} onText={setText} autoFocus />
          <div className="mem-actions">
            <span className="spacer" />
            <button className="btn" onClick={() => (setEditing(false), setText(m.text))}>
              Cancel
            </button>
            <button className="btn primary" disabled={!text.trim() || text.trim().length > LIMITS[m.kind]} onClick={() => void update({ text }).then((ok) => ok && setEditing(false))}>
              Save
            </button>
          </div>
        </>
      ) : (
        <p className="mem-text" onDoubleClick={() => !closed && setEditing(true)} title={closed ? undefined : "Double-click to edit"}>
          {m.kind === "playbook" ? <span className="mem-playbook">{m.text}</span> : m.text}
        </p>
      )}
      <div className="mem-actions">
        <KindSelect value={m.kind} onChange={(kind) => void update({ kind })} />
        {m.status === "rejected" && <span className="tag">turned down</span>}
        {m.status === "archived" && <span className="tag">archived</span>}
        {leftOut && (
          <span className="tag mem-warn" title="Over the budget: agents find it by searching, but don't get it up front. Pin it or shorten others.">
            left out
          </span>
        )}
        {stale && (
          <span className="tag" title="No agent has used it in 30 days">
            stale
          </span>
        )}
        {m.sourceIssue && (
          <a className="task-link" href={`#/t/${m.sourceIssue}`} title={m.createdBy ? `From ${m.createdBy}` : undefined}>
            <span className="ident">{m.sourceIssue}</span>
          </a>
        )}
        <span className="spacer" />
        {!closed && (
          <>
            <button className={`tag toggle${m.pinned ? " on" : ""}`} onClick={() => void update({ pinned: !m.pinned })} title="Pinned ones come first and are never left out first">
              {m.pinned ? "Pinned" : "Pin"}
            </button>
            <button className={`tag toggle${m.sensitive ? " on" : ""}`} onClick={() => void update({ sensitive: !m.sensitive })} title="Private: never sent to OpenRouter's providers">
              Private
            </button>
            <button className="tag toggle" onClick={() => setEditing(true)}>
              Edit
            </button>
            <ScopeSelect value={m.scope} scopes={scopes} onChange={(scope) => void update({ scope })} />
            <button className="tag toggle" onClick={() => void update({ status: "archived" })} title="Kept, but no agent gets it">
              Archive
            </button>
          </>
        )}
        {closed && (
          <button className="tag toggle" onClick={() => void update({ status: "active" })}>
            Restore
          </button>
        )}
        <button className="tag toggle" onClick={() => confirm("Delete this memory for good?") && void act(() => memoryApi.remove(m.id))}>
          Delete
        </button>
      </div>
    </div>
  );
}

function PastTasks({ query, scopes }: { query: string; scopes: MemoryScope[] }) {
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const t = setTimeout(() => void memoryApi.episodes(query.trim()).then((r) => (setEpisodes(r.episodes), setError("")), (e) => setError((e as Error).message)), query ? 300 : 0);
    return () => clearTimeout(t);
  }, [query]);
  if (!episodes) return error ? <p className="empty">Couldn't load past tasks: {error}</p> : <span className="spinner" />;
  return (
    <section>
      <header className="agents-head">
        <h2>Past tasks</h2>
        <span className="count">{episodes.length}</span>
        <span className="hint">{query ? "Best matches" : "Finished crew work, newest first: agents search these when you say “like we did for…”"}</span>
      </header>
      {episodes.map((e) => {
        const s = scopes.find((x) => x.scope === e.scope);
        return (
          <div key={e.issueId} className="mem-card episode">
            <div className="mem-head">
              <Portrait scope={s} size={22} />
              <a className="task-link" href={`#/t/${e.identifier}`}>
                <span className="ident">{e.identifier}</span>
                <span className="task-title">{e.title}</span>
              </a>
              <span className="spacer" />
              <span className="muted small" title={new Date(e.closedAt).toLocaleString()}>
                {s?.name ?? e.scope} · {ago(e.closedAt)}
              </span>
            </div>
            {e.summary && <p className="mem-text mem-summary">{e.summary}</p>}
            {e.links.length > 0 && (
              <div className="mem-actions">
                {e.links.map((l) => (
                  <a key={l} className="tag" href={l} target="_blank" rel="noreferrer">
                    {l.replace(/^https:\/\/github\.com\//, "").replace("/pull/", "#")}
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {!episodes.length && <p className="empty">{query ? "No past task matches." : "No finished crew work recorded yet."}</p>}
    </section>
  );
}
