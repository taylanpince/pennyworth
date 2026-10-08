import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Avatar, Chips, CloseIcon, MoveMenu } from "./components";
import { Markdown } from "./markdown";
import { BUCKETS, BUCKET_NAMES, WEEKDAYS, type Assignee, type Board, type Bucket, type Cadence, type IssueView, type Label, type Models, type Update, type Weekday } from "./types";
import { PRIORITIES, PRIORITY_NAMES, ago, runTime, shortName, when } from "./util";

interface Props {
  refId: string;
  board: Board;
  onClose: () => void;
  onChanged: () => void;
  onMove: (id: string, bucket: Bucket) => Promise<void>;
  toast: (text: string, action?: { label: string; run: () => void }) => void;
}

export function Drawer({ refId, board, onClose, onChanged, onMove, toast }: Props) {
  const [issue, setIssue] = useState<IssueView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(true);

  const load = useCallback(async () => {
    try {
      const v = await api.issue(refId);
      if (live.current) setIssue(v), setError("");
    } catch (e) {
      if (live.current) setError((e as Error).message);
    }
  }, [refId]);

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
          <IssueBody issue={issue} board={board} busy={busy} update={update} setStatus={setStatus} onClose={onClose} onMove={onMove} reload={load} onChanged={onChanged} toast={toast} />
        )}
      </aside>
    </div>
  );
}

interface BodyProps {
  issue: IssueView;
  board: Board;
  busy: boolean;
  update: (u: Update, note?: string) => Promise<void>;
  setStatus: (s: "todo" | "in_progress" | "done" | "cancelled") => Promise<void>;
  onClose: () => void;
  onMove: (id: string, bucket: Bucket) => Promise<void>;
  reload: () => Promise<void>;
  onChanged: () => void;
  toast: Props["toast"];
}

function IssueBody({ issue, board, busy, update, setStatus, onClose, onMove, reload, onChanged, toast }: BodyProps) {
  const closed = issue.status === "done" || issue.status === "cancelled";
  const editable = issue.editable;
  const assignee = board.assignees.find((a) => a.key === issue.assignee);
  const [bucket, setBucket] = useState<Bucket | null>(issue.bucket);
  useEffect(() => setBucket(issue.bucket), [issue.bucket]);

  return (
    <>
      <header className="drawer-head">
        <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <CloseIcon />
        </button>
        <span className="ident">{issue.identifier}</span>
        <span className="head-chips">
          <Chips card={issue} />
        </span>
        <span className="spacer" />
        {editable && !closed && !issue.recurring && (
          <>
            <MoveMenu
              current={bucket ?? undefined}
              label={bucket ? BUCKET_NAMES[bucket] : "Move to"}
              onPick={(b) => {
                setBucket(b);
                void onMove(issue.id, b);
              }}
            />
            <button className="btn" disabled={busy} onClick={() => void setStatus("cancelled")}>
              Cancel task
            </button>
            <button className="btn primary" disabled={busy} onClick={() => void setStatus("done")}>
              Done
            </button>
          </>
        )}
        {editable && closed && (
          <button className="btn primary" disabled={busy} onClick={() => void update({ status: "todo" }, `${issue.identifier} reopened`)}>
            Reopen
          </button>
        )}
      </header>

      <div className="drawer-scroll">
        <Title issue={issue} editable={editable} save={(title) => update({ title })} />

        <section className="props">
          <Prop name="Assignee">
            <select disabled={!editable || busy} value={issue.assignee ?? ""} onChange={(e) => void update({ assignee: e.target.value }, assigneeNote(board.assignees.find((a) => a.key === e.target.value)))}>
              {!issue.assignee && <option value="">Someone else</option>}
              {board.assignees.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.name}
                </option>
              ))}
            </select>
          </Prop>
          {assignee?.kind === "engineer" && <Executor issue={issue} assignee={assignee} disabled={!editable || busy} update={update} />}
          <Prop name="Priority">
            <select disabled={!editable || busy} value={issue.priority} onChange={(e) => void update({ priority: e.target.value as Update["priority"] })}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_NAMES[p]}
                </option>
              ))}
            </select>
          </Prop>
          {!closed && (
            <Prop name="Status">
              <select disabled={!editable || busy || !["todo", "in_progress"].includes(issue.status)} value={issue.status} onChange={(e) => void update({ status: e.target.value as "todo" })}>
                <option value="todo">To do</option>
                <option value="in_progress">In progress</option>
                {!["todo", "in_progress"].includes(issue.status) && <option value={issue.status}>{issue.status.replace("_", " ")}</option>}
              </select>
            </Prop>
          )}
          <Prop name="Labels">
            <Labels all={board.labels} selected={issue.labelIds} disabled={!editable || busy} save={(labelIds) => update({ labelIds })} />
          </Prop>
          {editable && !closed && !issue.recurring && (
            <Prop name="Bring back">
              <BringBack issue={issue} board={board} done={() => (void reload(), onChanged())} toast={toast} />
            </Prop>
          )}
          {editable && !closed && (issue.recurring || issue.assignee === "me") && (
            <Prop name="Repeats">
              <Repeats issue={issue} board={board} done={() => (void reload(), onChanged())} toast={toast} />
            </Prop>
          )}
          <Prop name="Created">
            <span className="muted">{when(issue.createdAt)}</span>
          </Prop>
        </section>

        <Description issue={issue} prefix={board.prefix} editable={editable} save={(description) => update({ description })} />

        <section className="thread">
          <h3>Activity</h3>
          {issue.comments.length === 0 && <p className="muted small">No comments yet.</p>}
          {issue.comments.map((c) => (
            <article key={c.id} className={`comment comment-${c.author.kind}`}>
              <div className="comment-head">
                <span className={`who who-${c.author.kind}`}>{c.author.kind === "runner" ? `Runner${assignee?.kind === "engineer" ? ` · ${shortName(assignee)}` : ""}` : c.author.name}</span>
                <span className="muted small" title={new Date(c.createdAt).toLocaleString()}>
                  {ago(c.createdAt)}
                </span>
              </div>
              <Markdown text={c.body} prefix={board.prefix} />
            </article>
          ))}
        </section>
      </div>

      {editable && <Composer issue={issue} reload={reload} toast={toast} />}
    </>
  );
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

function Composer({ issue, reload, toast }: { issue: IssueView; reload: () => Promise<void>; toast: Props["toast"] }) {
  const key = `draft:${issue.id}`;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });
  const [sending, setSending] = useState(false);
  useEffect(() => {
    try {
      if (text) localStorage.setItem(key, text);
      else localStorage.removeItem(key);
    } catch {}
  }, [key, text]);
  async function send() {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await api.comment(issue.id, text);
      setText("");
      await reload();
    } catch (e) {
      toast(`Couldn't send: ${(e as Error).message}`);
    } finally {
      setSending(false);
    }
  }
  return (
    <footer className="composer">
      <textarea
        placeholder="Reply… (⌘↵ to send)"
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.preventDefault(), void send();
          if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
        }}
      />
      <div className="row-end">
        <span className="muted small">{issue.replyTarget}</span>
        <button className="btn primary" disabled={!text.trim() || sending} onClick={() => void send()}>
          {sending ? "Sending…" : "Send"}
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
