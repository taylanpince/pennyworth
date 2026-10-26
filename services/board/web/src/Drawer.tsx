import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import { Avatar, Chips, CloseIcon, CrewAvatar, MoveMenu, memberIssue } from "./components";
import { Markdown } from "./markdown";
import { BUCKETS, BUCKET_NAMES, WEEKDAYS, type Assignee, type Board, type Bucket, type Cadence, type CommentView, type CrewState, type IssueView, type Label, type Models, type Update, type Weekday } from "./types";
import { PRIORITIES, PRIORITY_NAMES, ago, elapsed, runTime, shortName, when } from "./util";

interface Props {
  refId: string;
  /** An agent's part of the task to open on (D-45). */
  focus?: string;
  board: Board;
  onClose: () => void;
  onChanged: () => void;
  onMove: (id: string, bucket: Bucket) => Promise<void>;
  toast: (text: string, action?: { label: string; run: () => void }) => void;
}

export function Drawer({ refId, focus, board, onClose, onChanged, onMove, toast }: Props) {
  const [issue, setIssue] = useState<IssueView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(true);

  const load = useCallback(async () => {
    try {
      const v = await api.issue(refId);
      if (!live.current) return;
      // An agent's part of a task opens as that agent's tab on the task (D-45).
      if (v.parent && board.assignees.some((a) => a.kind !== "me" && a.key === v.assignee)) {
        location.replace(`#/t/${v.parent.identifier}/${v.identifier}`);
        return;
      }
      setIssue(v), setError("");
    } catch (e) {
      if (live.current) setError((e as Error).message);
    }
  }, [refId, board.assignees]);

  useEffect(() => {
    live.current = true;
    setIssue(null);
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 6000);
    return () => {
      live.current = false;
      clearInterval(t);
    };
  }, [load]);

  async function update(u: Update, note?: string) {
    if (!issue) return;
    setBusy(true);
    try {
      setIssue(await api.update(issue.id, u));
      onChanged();
      if (note) toast(note);
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: "todo" | "in_progress" | "done" | "cancelled") {
    if (!issue) return;
    const before = issue.status;
    await update({ status });
    if (status === "done" || status === "cancelled") {
      toast(`${issue.identifier} ${status === "done" ? "done" : "cancelled"}`, { label: "Undo", run: () => void api.update(issue.id, { status: before === "in_progress" ? "in_progress" : "todo" }).then(onChanged) });
      onClose();
    }
  }

  return (
    <div className="drawer-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-label="Task">
        {!issue ? (
          <div className="drawer-loading">{error ? `Couldn't load ${refId}: ${error}` : "Loading…"}</div>
        ) : (
          <IssueBody issue={issue} focus={focus} board={board} busy={busy} update={update} setStatus={setStatus} onClose={onClose} onMove={onMove} reload={load} onChanged={onChanged} toast={toast} setIssue={setIssue} />
        )}
      </aside>
    </div>
  );
}

interface BodyProps {
  issue: IssueView;
  focus?: string;
  board: Board;
  busy: boolean;
  update: (u: Update, note?: string) => Promise<void>;
  setStatus: (s: "todo" | "in_progress" | "done" | "cancelled") => Promise<void>;
  onClose: () => void;
  onMove: (id: string, bucket: Bucket) => Promise<void>;
  reload: () => Promise<void>;
  onChanged: () => void;
  toast: Props["toast"];
  setIssue: (v: IssueView) => void;
}

type Member = IssueView["crew"][number];

/**
 * The task (D-45): an Overview (description, files, the crew, and the team chat that goes to the
 * Assistant) and a tab per agent with a direct chat. Settings live behind Details.
 */
function IssueBody({ issue, focus, board, busy, update, setStatus, onClose, onMove, reload, onChanged, toast, setIssue }: BodyProps) {
  const closed = issue.status === "done" || issue.status === "cancelled";
  const editable = issue.editable;
  const mine = issue.assignee === "me";
  const [bucket, setBucket] = useState<Bucket | null>(issue.bucket);
  useEffect(() => setBucket(issue.bucket), [issue.bucket]);
  const focused = focus && issue.crew.find((m) => m.issues.some((i) => i.identifier === focus))?.agent;
  const [tab, setTab] = useState<string>(focused || "overview");
  useEffect(() => {
    if (focused) setTab(focused);
  }, [focused]);
  const [details, setDetails] = useState(false);
  const [adding, setAdding] = useState(false);
  const member = issue.crew.find((m) => m.agent === tab);
  const pick = (t: string) => {
    setTab(t);
    setAdding(false);
    history.replaceState(null, "", t === "overview" ? `#/t/${issue.identifier}` : `#/t/${issue.identifier}/${memberIssue(issue.crew.find((m) => m.agent === t)!)}`);
  };
  const who = (key: string) => board.assignees.find((a) => a.key === key);

  return (
    <>
      <header className="drawer-head">
        <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <CloseIcon />
        </button>
        <span className="ident">{issue.identifier}</span>
        <span className="spacer" />
        {editable && !closed && !issue.recurring && !issue.parent && (
          <MoveMenu
            current={bucket ?? undefined}
            label={bucket ? BUCKET_NAMES[bucket] : "Move to"}
            onPick={(b) => {
              setBucket(b);
              void onMove(issue.id, b);
            }}
          />
        )}
        <button className={`btn${details ? " on" : ""}`} onClick={() => setDetails(!details)} title="Priority, labels, schedule, repeat">
          Details
        </button>
        {editable && !closed && (
          <button className="btn primary" disabled={busy} onClick={() => void setStatus("done")}>
            Done
          </button>
        )}
        {editable && closed && (
          <button className="btn primary" disabled={busy} onClick={() => void update({ status: "todo" }, `${issue.identifier} reopened`)}>
            Reopen
          </button>
        )}
      </header>
      {issue.parent && (
        <div className="part-of">
          Part of <a href={`#/t/${issue.parent.identifier}`}>{issue.parent.identifier}{issue.parent.title ? `: ${issue.parent.title}` : ""}</a>
        </div>
      )}
      <div className="task-top">
        <Title issue={issue} editable={editable} save={(title) => update({ title })} />
        <div className="head-chips">
          <Chips card={{ ...issue, working: null, status: issue.crew.length ? "todo" : issue.status }} />
          {issue.priority !== "medium" && (
            <button className={`chip prio-${issue.priority}`} onClick={() => setDetails(true)}>
              {PRIORITY_NAMES[issue.priority]}
            </button>
          )}
          {issue.scheduled && (
            <button className="chip" onClick={() => setDetails(true)}>
              ↑ {BUCKET_NAMES[issue.scheduled.bucket]} {longDate(issue.scheduled.date)}
            </button>
          )}
          {issue.recurring && (
            <button className="chip" onClick={() => setDetails(true)}>
              ↻ {issue.recurring.summary}
            </button>
          )}
        </div>
      </div>
      {(issue.crew.length > 0 || (mine && editable && !closed)) && (
        <nav className="task-tabs" aria-label="The crew on this task">
          <button className={`task-tab${tab === "overview" ? " on" : ""}`} onClick={() => pick("overview")}>
            Overview
          </button>
          {issue.crew.map((m) => (
            <button key={m.agent} className={`task-tab${tab === m.agent ? " on" : ""}`} onClick={() => pick(m.agent)}>
              <CrewAvatar member={m} assignee={who(m.agent)} size={20} />
              {shortName(who(m.agent))}
              {m.issues.length > 1 && <span className="fan">{m.finished ?? 0}/{m.issues.length}</span>}
            </button>
          ))}
          {mine && editable && !closed && (
            <button className="task-tab add" onClick={() => (setAdding(!adding), setDetails(false))}>
              + Add agent
            </button>
          )}
        </nav>
      )}
      <div className="task-body">
        <div className="task-main">
          {adding && (
            <AddAgent
              issue={issue}
              board={board}
              onCancel={() => setAdding(false)}
              onAdded={(v, agent) => {
                setIssue(v);
                setAdding(false);
                onChanged();
                pick(agent);
                toast(`${shortName(who(agent))} is on it`);
              }}
              toast={toast}
            />
          )}
          {member ? (
            <AgentPane key={member.agent} task={issue} member={member} focus={focus} board={board} reload={reload} onChanged={onChanged} toast={toast} />
          ) : (
            <Overview issue={issue} board={board} editable={editable} update={update} reload={reload} toast={toast} pick={pick} onAdd={() => setAdding(true)} />
          )}
        </div>
        {details && (
          <aside className="task-details">
            <div className="details-head">
              <h3>Details</h3>
              <button className="icon-btn subtle" aria-label="Close details" onClick={() => setDetails(false)}>
                <CloseIcon />
              </button>
            </div>
            <section className="props">
              <Prop name="Priority">
                <select disabled={!editable || busy} value={issue.priority} onChange={(e) => void update({ priority: e.target.value as Update["priority"] })}>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY_NAMES[p]}
                    </option>
                  ))}
                </select>
              </Prop>
              <Prop name="Labels">
                <Labels all={board.labels} selected={issue.labelIds} disabled={!editable || busy} save={(labelIds) => update({ labelIds })} />
              </Prop>
              {editable && !closed && !issue.recurring && !issue.parent && (
                <Prop name="Bring back">
                  <BringBack issue={issue} board={board} done={() => (void reload(), onChanged())} toast={toast} />
                </Prop>
              )}
              {editable && !closed && (issue.recurring || mine) && (
                <Prop name="Repeats">
                  <Repeats issue={issue} board={board} done={() => (void reload(), onChanged())} toast={toast} />
                </Prop>
              )}
              <Prop name="Created">
                <span className="muted">{when(issue.createdAt)}</span>
              </Prop>
            </section>
            {editable && !closed && (
              <button className="btn details-cancel" disabled={busy} onClick={() => void setStatus("cancelled")}>
                Cancel task
              </button>
            )}
          </aside>
        )}
      </div>
    </>
  );
}

/** The task itself: what it's about, its files, who's on it, and the team chat (the Assistant reads it). */
function Overview({ issue, board, editable, update, reload, toast, pick, onAdd }: { issue: IssueView; board: Board; editable: boolean; update: (u: Update) => Promise<void>; reload: () => Promise<void>; toast: Props["toast"]; pick: (t: string) => void; onAdd: () => void }) {
  const mine = issue.assignee === "me";
  const closed = issue.status === "done" || issue.status === "cancelled";
  const assistant = board.assignees.find((a) => a.kind === "assistant");
  // The overview opens at the top, on what the task is about; it follows the chat only once you're there.
  const scroll = useFollow(issue.comments, false);
  return (
    <>
      <div className="drawer-scroll" {...scroll}>
        <Description issue={issue} prefix={board.prefix} editable={editable} save={(description) => update({ description })} />
        <Files issue={issue} />
        {issue.crew.length > 0 ? (
          <section className="crew-rows">
            {issue.crew.map((m) => {
              const a = board.assignees.find((x) => x.key === m.agent);
              return (
                <button key={m.agent} className="crew-row" onClick={() => pick(m.agent)}>
                  <CrewAvatar member={m} assignee={a} size={28} />
                  <span className="crew-row-text">
                    <span>
                      <b>{shortName(a)}</b> <span className={`pill pill-${m.state}`}>{STATE_PILLS[m.state]}{m.issues.length > 1 ? ` · ${m.finished ?? 0}/${m.issues.length}` : ""}</span>
                    </span>
                    {m.said && <span className="crew-said">{m.said.text}</span>}
                  </span>
                  {m.said && <span className="muted small">{ago(m.said.at)}</span>}
                </button>
              );
            })}
          </section>
        ) : (
          mine &&
          editable &&
          !closed && (
            <div className="crew-empty">
              <span>Nobody's on this yet. It's yours, or hand it to someone.</span>
              <button className="btn" onClick={onAdd}>
                + Add agent
              </button>
            </div>
          )
        )}
        {(mine || !issue.crew.length) && <Thread issue={issue} board={board} prefix={board.prefix} title={mine && assistant ? "Team chat" : "Activity"} />}
      </div>
      {editable && (mine || !issue.crew.length) && (
        <Composer issue={issue} reload={reload} toast={toast} to={mine && assistant ? { assignee: assistant, label: `${shortName(assistant)} reads this and brings in whoever's needed` } : undefined} />
      )}
    </>
  );
}

const STATE_PILLS: Record<CrewState, string> = { needs: "needs you", failed: "stuck", proposed: "proposed", working: "working", queued: "queued", done: "done" };
const ENGINE_NAMES: Record<string, string> = { codex: "Codex", claude: "Claude Code", openrouter: "OpenRouter" };

/** One agent's part of the task: who they are, where they stand, and a direct chat with them. */
function AgentPane({ task, member, focus, board, reload, onChanged, toast }: { task: IssueView; member: Member; focus?: string; board: Board; reload: () => Promise<void>; onChanged: () => void; toast: Props["toast"] }) {
  const agent = board.assignees.find((a) => a.key === member.agent);
  const name = shortName(agent);
  const [selected, setSelected] = useState(() => member.issues.find((i) => i.identifier === focus)?.identifier ?? memberIssue(member));
  const self = selected === task.identifier;
  const [part, setPart] = useState<IssueView | null>(self ? task : null);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const load = useCallback(async () => {
    try {
      const v = await api.issue(selected);
      if (live.current) setPart(v);
    } catch {}
  }, [selected]);
  useEffect(() => {
    live.current = true;
    if (self) {
      setPart(task);
      return;
    }
    setPart(null);
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 6000);
    return () => {
      live.current = false;
      clearInterval(t);
    };
  }, [load, self, task]);
  const scroll = useFollow(part?.comments ?? []);
  const sub = member.issues.find((i) => i.identifier === selected);
  const state = sub?.state ?? member.state;
  const fan = member.issues.length > 1;
  // "Hand to Ada": the careful one, unless it's Ada who got stuck.
  const engineers = board.assignees.filter((a) => a.kind === "engineer" && a.key !== member.agent);
  const next = engineers.find((a) => a.engine === "claude") ?? engineers[0];

  async function act(run: () => Promise<unknown>, note: string) {
    setBusy(true);
    try {
      await run();
      toast(note);
      onChanged();
      await Promise.all([reload(), self ? Promise.resolve() : load()]);
    } catch (e) {
      toast(`Couldn't do that: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="drawer-scroll" {...scroll}>
        <div className="agent-head">
          <CrewAvatar member={{ state, since: member.since }} assignee={agent} size={44} />
          <div>
            <div className="agent-name">
              {name} <span className={`pill pill-${state}`}>{STATE_PILLS[state]}</span>
            </div>
            <div className="muted small">{agent?.kind === "assistant" ? "Assistant · research and drafts" : `Engineer · ${ENGINE_NAMES[agent?.engine ?? ""] ?? agent?.name}`}</div>
            {agent?.persona?.voice && <div className="agent-voice">{agent.persona.voice}</div>}
          </div>
        </div>
        {fan && (
          <section className="fan-list">
            <div className="fan-head">
              <b>
                {member.finished ?? 0} of {member.issues.length} finished
              </b>
              {member.issues.some((i) => i.state === "proposed") && (
                <button className="btn primary" disabled={busy} onClick={() => void act(() => api.comment(task.id, "Go."), `Starting ${name}'s tasks`)}>
                  Approve all
                </button>
              )}
            </div>
            {member.issues.map((i) => (
              <button key={i.id} className={`fan-row${i.identifier === selected ? " on" : ""}`} onClick={() => setSelected(i.identifier)}>
                <span className={`pill pill-${i.state}`}>{STATE_PILLS[i.state]}</span>
                <span className="fan-title">{i.title}</span>
                <span className="ident">{i.identifier}</span>
              </button>
            ))}
          </section>
        )}
        {state === "proposed" && part && (
          <div className="crew-banner proposed">
            <span>
              <b>Proposed for this task.</b> {name} starts once you approve; the instructions are below.
            </span>
            <span className="spacer" />
            <button className="btn" disabled={busy} onClick={() => void act(() => api.update(part.id, { status: "cancelled" }), `Dismissed ${name}`)}>
              Dismiss
            </button>
            <button className="btn primary" disabled={busy} onClick={() => void act(() => api.comment(part.id, "Approved."), `${name} is starting`)}>
              Approve
            </button>
          </div>
        )}
        {state === "failed" && part && (
          <div className="crew-banner failed">
            <b>{name} got stuck.</b>
            <span className="spacer" />
            <button className="btn" disabled={busy} onClick={() => void act(() => api.comment(part.id, "Try again."), `${name} is trying again`)}>
              Try again
            </button>
            {next && task.assignee === "me" && !self && (
              <button className="btn primary" disabled={busy} onClick={() => void act(() => api.handOver(task.id, part.id, next.key), `${shortName(next)} picked it up`)}>
                Hand to {shortName(next)}
              </button>
            )}
          </div>
        )}
        {part?.working && (
          <div className={`working-line${part.working.queued ? " queued" : ""}`}>
            {part.working.queued ? `Queued: ${name} starts when a slot frees up.` : `${name} is working on this${part.working.since ? ` · ${elapsed(part.working.since)}` : ""}.`}
          </div>
        )}
        {part && agent?.kind === "engineer" && <ModelLine part={part} agent={agent} toast={toast} reload={self ? reload : load} />}
        {part && !self && part.description && (
          <details className="instructions" open={!part.comments.length}>
            <summary>Instructions</summary>
            <Markdown text={part.description} prefix={board.prefix} />
          </details>
        )}
        {part && !self && <Files issue={part} />}
        {part ? <Thread issue={part} board={board} prefix={board.prefix} agent={agent} title="Chat" /> : <p className="muted">Loading…</p>}
      </div>
      {part && part.editable && <Composer issue={part} reload={self ? reload : load} toast={toast} to={agent ? { assignee: agent, label: `Direct to ${name}` } : undefined} />}
    </>
  );
}

/** An Engineer's model and effort for this part, out of the way until needed (D-20). */
function ModelLine({ part, agent, toast, reload }: { part: IssueView; agent: Assignee; toast: Props["toast"]; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const label = [part.executor?.model ?? agent.defaultModel?.replace(/^openrouter\//, "") ?? "default model", part.executor?.effort && `${part.executor.effort} effort`].filter(Boolean).join(" · ");
  const update = async (u: Update) => {
    try {
      await api.update(part.id, u);
      await reload();
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`);
    }
  };
  return (
    <div className="model-line">
      <span className="muted small">{label}</span>
      <button className="link-btn" onClick={() => setOpen(!open)}>
        {open ? "Done" : "Change"}
      </button>
      {open && (
        <section className="props">
          <Executor issue={part} assignee={agent} disabled={false} update={update} />
        </section>
      )}
    </div>
  );
}

/** Bring someone onto the task with instructions: they see the description and what the others found. */
function AddAgent({ issue, board, onCancel, onAdded, toast }: { issue: IssueView; board: Board; onCancel: () => void; onAdded: (v: IssueView, agent: string) => void; toast: Props["toast"] }) {
  const crew = board.assignees.filter((a) => a.kind !== "me");
  const present = new Set(issue.crew.map((m) => m.agent));
  const [pick, setPick] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function assign() {
    if (!pick || !text.trim()) return;
    setBusy(true);
    try {
      onAdded(await api.addAgent(issue.id, pick, text.trim()), pick);
    } catch (e) {
      toast(`Couldn't add: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="add-agent">
      <h3>Add someone to this task</h3>
      <CrewPicker crew={crew} present={present} pick={pick} setPick={setPick} />
      <textarea
        autoFocus
        value={text}
        placeholder={pick ? `What should ${shortName(crew.find((a) => a.key === pick))} do? They see the description and what the others have found.` : "Pick someone first."}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.preventDefault(), void assign();
          if (e.key === "Escape") e.stopPropagation(), onCancel();
        }}
      />
      <div className="row-end">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={!pick || !text.trim() || busy} onClick={() => void assign()}>
          {pick ? `Assign to ${shortName(crew.find((a) => a.key === pick))}` : "Assign"}
        </button>
      </div>
    </div>
  );
}

/** The crew as big portraits to pick from; someone already on the task can't be picked twice. */
export function CrewPicker({ crew, present, pick, setPick, me }: { crew: Assignee[]; present?: Set<string>; pick: string | null; setPick: (k: string | null) => void; me?: boolean }) {
  return (
    <div className="crew-picker">
      {me && (
        <button type="button" className={`pick${!pick ? " on" : ""}`} onClick={() => setPick(null)}>
          <span className="avatar avatar-me pick-me">Y</span>
          <b>Just me</b>
          <span>A todo for you</span>
        </button>
      )}
      {crew.map((a) => (
        <button key={a.key} type="button" className={`pick${pick === a.key ? " on" : ""}`} disabled={present?.has(a.key)} onClick={() => setPick(a.key)}>
          <Avatar assignee={a} size={40} />
          <b>{shortName(a)}</b>
          <span>{present?.has(a.key) ? "already on it" : a.kind === "assistant" ? "Assistant" : `Engineer · ${ENGINE_NAMES[a.engine ?? ""] ?? ""}`}</span>
        </button>
      ))}
    </div>
  );
}

/** Open on the latest comment, and follow new ones while the reader is at the end (or just replied). */
function useFollow(comments: CommentView[], openAtEnd = true) {
  const ref = useRef<HTMLDivElement>(null);
  const atEnd = useRef(openAtEnd);
  const seen = useRef<string | undefined>(undefined);
  const latest = comments.at(-1);
  useLayoutEffect(() => {
    const el = ref.current;
    const last = el?.querySelector<HTMLElement>(".thread > .comment:last-child");
    if (!el || !last || latest?.id === seen.current) return;
    const first = seen.current === undefined;
    seen.current = latest?.id;
    if (first ? !openAtEnd : !atEnd.current && latest?.author.kind !== "me") return;
    const top = last.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    el.scrollTop = last.offsetHeight > el.clientHeight - 24 ? top - 12 : el.scrollHeight;
  }, [latest]);
  return { ref, onScroll: (e: React.UIEvent<HTMLDivElement>) => (atEnd.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 80) };
}

/** The latest comments stay open; older ones fold into one-line rows that open on a click. */
const OPEN_COMMENTS = 2;

function Thread({ issue, board, agent, prefix, title = "Activity" }: { issue: IssueView; board: Board; agent?: Assignee; prefix: string; title?: string }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const comments = issue.comments;
  const older = comments.slice(0, Math.max(0, comments.length - OPEN_COMMENTS));
  const allOpen = older.every((c) => open.has(c.id));
  const toggle = (id: string) => setOpen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  // Agents by their crew name (D-45); the runner speaks for the Engineer on the task.
  const who = (c: CommentView) => {
    if (c.author.kind === "runner") return agent?.kind === "engineer" ? shortName(agent) : "Runner";
    if (c.author.kind === "agent") return shortName(board.assignees.find((a) => a.name === c.author.name)) || c.author.name;
    return c.author.name;
  };
  const time = (c: CommentView) => (
    <span className="muted small" title={new Date(c.createdAt).toLocaleString()}>
      {ago(c.createdAt)}
    </span>
  );
  return (
    <section className="thread">
      <div className="thread-head">
        <h3>{title}</h3>
        {older.length > 0 && (
          <button className="link-btn" onClick={() => setOpen(allOpen ? new Set() : new Set(older.map((c) => c.id)))}>
            {allOpen ? "Fold earlier" : `Show all ${comments.length}`}
          </button>
        )}
      </div>
      {comments.length === 0 && <p className="muted small">No comments yet.</p>}
      {comments.map((c, i) => {
        const old = i < older.length;
        if (old && !open.has(c.id))
          return (
            <button key={c.id} className={`comment folded comment-${c.author.kind}`} title="Show the whole comment" onClick={() => toggle(c.id)}>
              <span className={`who who-${c.author.kind}`}>{who(c)}</span>
              <span className="preview">{preview(c.body)}</span>
              {time(c)}
            </button>
          );
        return (
          <article key={c.id} className={`comment comment-${c.author.kind}`}>
            <div className={`comment-head${old ? " foldable" : ""}`} title={old ? "Fold" : undefined} onClick={old ? () => toggle(c.id) : undefined}>
              <span className={`who who-${c.author.kind}`}>{who(c)}</span>
              {time(c)}
            </div>
            <Markdown text={c.body} prefix={prefix} />
          </article>
        );
      })}
    </section>
  );
}

/** One line of a comment's text for its folded row. */
function preview(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, " … ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function assigneeNote(a: Assignee | undefined): string | undefined {
  if (a?.kind === "assistant") return "Assigned to the Assistant: it starts on this now.";
  if (a?.kind === "engineer") return `Assigned to ${a.name}. The runner starts if you wrote this task; otherwise tell it what to do.`;
  return undefined;
}

function Prop({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <>
      <div className="prop-name">{name}</div>
      <div className="prop-value">{children}</div>
    </>
  );
}

function Title({ issue, editable, save }: { issue: IssueView; editable: boolean; save: (t: string) => Promise<void> }) {
  const [value, setValue] = useState(issue.title);
  useEffect(() => setValue(issue.title), [issue.title]);
  const commit = () => {
    const t = value.trim();
    if (t && t !== issue.title) void save(t);
    else setValue(issue.title);
  };
  return (
    <textarea
      className="title-input"
      rows={1}
      value={value}
      readOnly={!editable}
      onChange={(e) => setValue(e.target.value.replace(/\n/g, " "))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
        if (e.key === "Escape") {
          setValue(issue.title);
          e.stopPropagation();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      ref={(el) => {
        if (el) (el.style.height = "auto"), (el.style.height = `${el.scrollHeight}px`);
      }}
    />
  );
}

function Executor({ issue, assignee, disabled, update }: { issue: IssueView; assignee: Assignee; disabled: boolean; update: (u: Update) => Promise<void> }) {
  const [models, setModels] = useState<Models | null>(null);
  const [model, setModel] = useState(issue.executor?.model ?? "");
  useEffect(() => setModel(issue.executor?.model ?? ""), [issue.executor?.model]);
  useEffect(() => {
    let live = true;
    api.models(assignee.key).then((m) => live && setModels(m), () => {});
    return () => {
      live = false;
    };
  }, [assignee.key]);
  const listId = `models-${assignee.key}`;
  const commit = () => {
    if (model.trim() !== (issue.executor?.model ?? "")) void update({ model: model.trim() });
  };
  return (
    <>
      <div className="prop-name">Model</div>
      <div className="prop-value">
        <input
          list={listId}
          disabled={disabled}
          value={model}
          placeholder={`Default${assignee.defaultModel ? ` (${assignee.defaultModel.replace(/^openrouter\//, "")})` : ""}`}
          onChange={(e) => setModel(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <datalist id={listId}>
          {models?.models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
      {(assignee.efforts?.length ?? 0) > 0 && (
        <>
          <div className="prop-name">Effort</div>
          <div className="prop-value">
            <div className="seg">
              {["", ...(assignee.efforts ?? [])].map((e) => (
                <button key={e || "default"} disabled={disabled} className={(issue.executor?.effort ?? "") === e ? "on" : ""} onClick={() => void update({ effort: e })}>
                  {e || "Default"}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}

// Machine labels, and waiting-on (no longer used: only your own actions become tasks).
const HIDDEN_LABELS = new Set(["daily-brief", "system-error", "waiting-on"]);

function Labels({ all, selected, disabled, save }: { all: Label[]; selected: string[]; disabled: boolean; save: (ids: string[]) => Promise<void> }) {
  const set = new Set(selected);
  return (
    <div className="label-picker">
      {all
        .filter((l) => !HIDDEN_LABELS.has(l.name) || set.has(l.id))
        .map((l) => (
          <button
            key={l.id}
            disabled={disabled}
            className={`tag toggle${set.has(l.id) ? " on" : ""}`}
            onClick={() => void save(set.has(l.id) ? selected.filter((x) => x !== l.id) : [...selected, l.id])}
          >
            <i style={{ background: l.color }} />
            {l.name}
          </button>
        ))}
    </div>
  );
}

function Description({ issue, prefix, editable, save }: { issue: IssueView; prefix: string; editable: boolean; save: (d: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(issue.description);
  useEffect(() => {
    if (!editing) setValue(issue.description);
  }, [issue.description, editing]);
  if (editing)
    return (
      <section className="desc">
        <textarea
          className="desc-input"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save(value).then(() => setEditing(false));
            if (e.key === "Escape") e.stopPropagation(), setEditing(false);
          }}
        />
        <div className="row-end">
          <span className="muted small">Markdown · ⌘↵ to save</span>
          <button className="btn" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save(value).then(() => setEditing(false))}>
            Save
          </button>
        </div>
      </section>
    );
  return (
    <section className={`desc${editable ? " editable" : ""}`} onDoubleClick={() => editable && setEditing(true)}>
      {issue.description ? <Markdown text={issue.description} prefix={prefix} /> : <p className="muted">No description.</p>}
      {editable && (
        <button className="link-btn" onClick={() => setEditing(true)}>
          Edit description
        </button>
      )}
    </section>
  );
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Files on the task (D-43). A PDF's text version is for the agents and isn't listed. */
function Files({ issue }: { issue: IssueView }) {
  const files = issue.files.filter((f) => !f.textOf);
  if (!files.length) return null;
  return (
    <section className="files">
      <h3>Files</h3>
      <ul>
        {files.map((f) => (
          <li key={f.id}>
            <a href={`/api/issues/${encodeURIComponent(issue.id)}/files/${f.id}`} target="_blank" rel="noopener noreferrer">
              {f.name}
            </a>
            <span className="muted small" title={new Date(f.createdAt).toLocaleString()}>
              {size(f.size)} · {f.by === "me" ? "you" : "agent"} · {ago(f.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Paperclip's limit for one file. */
const MAX_FILE = 10 * 1024 * 1024;

function Composer({ issue, reload, toast, to }: { issue: IssueView; reload: () => Promise<void>; toast: Props["toast"]; to?: { assignee: Assignee; label: string } }) {
  const key = `draft:${issue.id}`;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    try {
      if (text) localStorage.setItem(key, text);
      else localStorage.removeItem(key);
    } catch {}
  }, [key, text]);
  function add(list: FileList | null | undefined) {
    const picked = [...(list ?? [])];
    const big = picked.filter((f) => f.size > MAX_FILE);
    if (big.length) toast(`${big.map((f) => f.name).join(", ")} ${big.length > 1 ? "are" : "is"} over 10 MB`);
    setFiles((now) => [...now, ...picked.filter((f) => f.size <= MAX_FILE && f.size > 0)]);
  }
  async function send() {
    if ((!text.trim() && !files.length) || sending) return;
    setSending(true);
    try {
      // Files first, so whoever reads the comment finds them on the task.
      const names: string[] = [];
      for (const f of files) {
        await api.attach(issue.id, f);
        names.push(f.name);
        setFiles((now) => now.filter((x) => x !== f));
      }
      if (text.trim()) {
        await api.comment(issue.id, names.length ? `${text.trimEnd()}\n\nAttached: ${names.map((n) => `\`${n.replace(/`/g, "")}\``).join(", ")}` : text);
        setText("");
      } else toast(`Attached ${names.length === 1 ? names[0] : `${names.length} files`}`);
      await reload();
    } catch (e) {
      toast(`Couldn't send: ${(e as Error).message}`);
      await reload();
    } finally {
      setSending(false);
    }
  }
  return (
    <footer
      className="composer"
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        add(e.dataTransfer.files);
      }}
    >
      <textarea
        placeholder={`${to ? `Message ${shortName(to.assignee)}…` : "Reply…"} (⌘↵ to send; paste or drop files to attach)`}
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          if (!e.clipboardData.files.length) return;
          e.preventDefault();
          add(e.clipboardData.files);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.preventDefault(), void send();
          if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
        }}
      />
      {files.length > 0 && (
        <div className="attach-list">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="attach-chip" title={size(f.size)}>
              {f.name}
              <button className="icon-btn subtle" aria-label={`Remove ${f.name}`} disabled={sending} onClick={() => setFiles((now) => now.filter((x) => x !== f))}>
                <CloseIcon />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="row-end">
        {to ? (
          <span className="reply-to muted small">
            <Avatar assignee={to.assignee} size={16} />
            {to.label}
          </span>
        ) : (
          <span className="muted small">{issue.replyTarget}</span>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />
        <button className="btn" disabled={sending} title="Attach files as context for the agents" onClick={() => picker.current?.click()}>
          Attach
        </button>
        <button className="btn primary" disabled={(!text.trim() && !files.length) || sending} onClick={() => void send()}>
          {sending ? (files.length ? "Uploading…" : "Sending…") : "Send"}
        </button>
      </div>
    </footer>
  );
}

export { Avatar };

// ---------------------------------------------------------------- scheduled moves and recurring tasks (D-25)

const todayIn = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const longDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

interface AutoProps {
  issue: IssueView;
  board: Board;
  done: () => void;
  toast: Props["toast"];
}

/** Move the task to a column on a date (default: the top of Today). */
function BringBack({ issue, board, done, toast }: AutoProps) {
  const [date, setDate] = useState("");
  const [bucket, setBucket] = useState<Bucket>("today");
  const [busy, setBusy] = useState(false);
  const today = todayIn(board.timezone);
  async function save(body: { date: string; bucket: Bucket } | { clear: true }) {
    setBusy(true);
    try {
      const r = await api.schedule(issue.id, body);
      toast(r.movedNow ? `Moved to ${BUCKET_NAMES[bucket]}` : r.scheduled ? `Back on top of ${BUCKET_NAMES[r.scheduled.bucket]} on ${longDate(r.scheduled.date)}` : "No longer scheduled");
      setDate("");
      done();
    } catch (e) {
      toast(`Couldn't schedule: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  if (issue.scheduled)
    return (
      <span className="auto-row">
        <span>
          Top of {BUCKET_NAMES[issue.scheduled.bucket]} on {longDate(issue.scheduled.date)}
        </span>
        <button className="btn" disabled={busy} onClick={() => void save({ clear: true })}>
          Clear
        </button>
      </span>
    );
  return (
    <span className="auto-row">
      <input type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
      <select value={bucket} onChange={(e) => setBucket(e.target.value as Bucket)} aria-label="Column">
        {BUCKETS.filter((b) => b !== "triage").map((b) => (
          <option key={b} value={b}>
            {BUCKET_NAMES[b]}
          </option>
        ))}
      </select>
      <button className="btn" disabled={busy || !date} onClick={() => void save({ date, bucket })}>
        Schedule
      </button>
    </span>
  );
}

const NTH: [number | "last", string][] = [
  [1, "first"],
  [2, "second"],
  [3, "third"],
  [4, "fourth"],
  ["last", "last"],
];

/** Run the task's instructions on a schedule; each run lands on top of Today as its own task. */
function Repeats({ issue, board, done, toast }: AutoProps) {
  const r = issue.recurring;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cadence, setCadence] = useState<Cadence>(r?.cadence ?? { kind: "weekly", weekday: "monday", interval: 1 });
  const [time, setTime] = useState(r?.time ?? "07:00");
  const [repos, setRepos] = useState((r?.repos ?? []).join(", "));
  useEffect(() => {
    if (editing || !r) return;
    setCadence(r.cadence);
    setTime(r.time);
    setRepos(r.repos.join(", "));
  }, [r, editing]);

  async function act(body: Parameters<typeof api.recurring>[1], note: (v: IssueView["recurring"]) => string) {
    setBusy(true);
    try {
      const res = await api.recurring(issue.id, body);
      toast(note(res.recurring));
      setEditing(false);
      done();
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  const save = () =>
    act({ action: "set", cadence, time, repos: repos.split(/[\s,]+/).filter(Boolean) }, (v) => `${v?.summary}. Next: ${v?.upcoming[0] ? runTime(v.upcoming[0], board.timezone) : "—"}`);

  if (!r && !editing)
    return (
      <button className="btn" onClick={() => setEditing(true)}>
        Make recurring…
      </button>
    );

  if (r && !editing)
    return (
      <div className="auto-block">
        <div>
          {r.summary}
          {r.paused && <span className="muted"> · paused</span>}
          {r.runNowPending && <span className="muted"> · run starting</span>}
        </div>
        {!r.paused && r.upcoming.length > 0 && <div className="muted small">Next: {r.upcoming.map((t) => runTime(t, board.timezone)).join(" · ")}</div>}
        {r.repos.length > 0 && <div className="muted small">GitHub: {r.repos.join(", ")}</div>}
        <div className="auto-row">
          <button className="btn" disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </button>
          <button className="btn" disabled={busy || r.paused || r.runNowPending} onClick={() => void act({ action: "run_now" }, () => "Running now: the result lands on top of Today")}>
            Run now
          </button>
          <button className="btn" disabled={busy} onClick={() => void act({ action: r.paused ? "resume" : "pause" }, () => (r.paused ? "Resumed" : "Paused"))}>
            {r.paused ? "Resume" : "Pause"}
          </button>
          <button className="btn" disabled={busy} onClick={() => void act({ action: "stop" }, () => `${issue.identifier} no longer repeats`)}>
            Stop
          </button>
        </div>
      </div>
    );

  const weekday = "weekday" in cadence ? cadence.weekday : "monday";
  const setKind = (kind: Cadence["kind"]) =>
    setCadence(kind === "weekly" ? { kind, weekday, interval: 1 } : kind === "monthly_day" ? { kind, day: 1, interval: 1 } : { kind, nth: 1, weekday, interval: 1 });
  return (
    <div className="auto-block">
      <div className="auto-row">
        <select value={cadence.kind} onChange={(e) => setKind(e.target.value as Cadence["kind"])} aria-label="Repeats">
          <option value="weekly">Weekly</option>
          <option value="monthly_day">Monthly on a date</option>
          <option value="monthly_weekday">Monthly on a weekday</option>
        </select>
        <label className="muted small">
          every{" "}
          <input className="narrow" type="number" min={1} max={12} value={cadence.interval} onChange={(e) => setCadence({ ...cadence, interval: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })} />{" "}
          {cadence.kind === "weekly" ? "week(s)" : "month(s)"}
        </label>
      </div>
      <div className="auto-row">
        {cadence.kind === "monthly_weekday" && (
          <select value={String(cadence.nth)} onChange={(e) => setCadence({ ...cadence, nth: e.target.value === "last" ? "last" : Number(e.target.value) })} aria-label="Which">
            {NTH.map(([v, l]) => (
              <option key={l} value={String(v)}>
                {l}
              </option>
            ))}
          </select>
        )}
        {cadence.kind === "monthly_day" ? (
          <select value={String(cadence.day)} onChange={(e) => setCadence({ ...cadence, day: e.target.value === "last" ? "last" : Number(e.target.value) })} aria-label="Day">
            {Array.from({ length: 31 }, (_, i) => (
              <option key={i + 1} value={String(i + 1)}>
                day {i + 1}
              </option>
            ))}
            <option value="last">last day</option>
          </select>
        ) : (
          <select value={weekday} onChange={(e) => setCadence({ ...cadence, weekday: e.target.value as Weekday } as Cadence)} aria-label="Weekday">
            {WEEKDAYS.map((w) => (
              <option key={w} value={w}>
                {cap(w)}
              </option>
            ))}
          </select>
        )}
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
      </div>
      <input placeholder="GitHub repos (owner/name, comma-separated)" value={repos} onChange={(e) => setRepos(e.target.value)} aria-label="GitHub repositories" />
      <div className="muted small">Each run follows this task's description and lands on top of Today as a new task.</div>
      <div className="auto-row">
        <button className="btn primary" disabled={busy || !time} onClick={() => void save()}>
          Save
        </button>
        <button className="btn" disabled={busy} onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
