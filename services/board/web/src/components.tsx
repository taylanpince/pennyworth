import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { BUCKETS, BUCKET_NAMES, type Assignee, type Board, type Bucket, type Card, type CrewMember, type CrewState, type PlanItem, type Working } from "./types";
import { SOURCE_NAMES, STATUS_BADGE, addDays, agentShort, ago, elapsed, matches, shortDate, shortName, snoozeOptions, todayIn } from "./util";

/** A crew member's portrait (D-45), or a coloured letter for you and agents without one. */
export function Avatar({ assignee, size }: { assignee: Assignee | undefined; size?: number }) {
  if (!assignee) return null;
  const style = size ? { width: size, height: size } : undefined;
  if (assignee.persona) return <img className="avatar portrait" src={`/crew/${assignee.persona.avatar}.svg`} alt="" title={assignee.persona.name} style={style} draggable={false} />;
  const tone = assignee.kind === "me" ? "me" : assignee.kind === "assistant" ? "assistant" : assignee.engine ?? "agent";
  const letter = assignee.kind === "me" ? "Y" : shortName(assignee).slice(0, 1).toUpperCase();
  return (
    <span className={`avatar avatar-${tone}`} title={assignee.name}>
      {letter}
    </span>
  );
}

const STATE_WORDS: Record<CrewState, string> = { needs: "needs you", failed: "got stuck", proposed: "waiting for your approval", working: "working", queued: "queued", done: "done" };

/** A crew member's portrait with a ring for where they stand (D-45). */
export function CrewAvatar({ member, assignee, size }: { member: Pick<CrewMember, "state" | "since">; assignee: Assignee | undefined; size?: number }) {
  return (
    <span className={`crew-av st-${member.state}`} title={`${shortName(assignee)}: ${STATE_WORDS[member.state]}${member.state === "working" && member.since ? ` · ${elapsed(member.since)}` : ""}`}>
      <Avatar assignee={assignee} size={size} />
      <span className="pip" />
    </span>
  );
}

/** The issue to open for a crew member: the one that wants the user, else the first. */
export const memberIssue = (m: CrewMember) => (m.issues.find((i) => i.state === m.state) ?? m.issues[0])!.identifier;

/** The line under a card's title: the most urgent crew member, in words. */
export function crewLine(crew: CrewMember[], assignees: Assignee[]): { text: string; tone: CrewState } | undefined {
  const order: CrewState[] = ["needs", "failed", "proposed", "working", "queued"];
  for (const state of order) {
    const m = crew.find((x) => x.state === state);
    if (!m) continue;
    const name = shortName(assignees.find((a) => a.key === m.agent));
    const fan = m.issues.length > 1 ? ` · ${m.finished ?? 0}/${m.issues.length}` : "";
    const text = { needs: `${name} needs you`, failed: `${name} got stuck`, proposed: `Approve ${name}?`, working: `${name} is working${m.since ? ` · ${elapsed(m.since)}` : ""}`, queued: `${name} is queued`, done: "" }[state];
    return { text: text + fan, tone: state };
  }
  return undefined;
}

function CrewRow({ card, crew, assignees }: { card: Card; crew: CrewMember[]; assignees: Assignee[] }) {
  const line = crewLine(crew, assignees);
  return (
    <div className="card-crew">
      <span className="crew-stack">
        {crew.map((m) => (
          <a
            key={m.agent}
            href={`#/t/${card.identifier}/${memberIssue(m)}`}
            className="crew-link"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={`Open ${shortName(assignees.find((a) => a.key === m.agent))}'s work`}
          >
            <CrewAvatar member={m} assignee={assignees.find((a) => a.key === m.agent)} />
            {m.issues.length > 1 && <span className="fan">{m.finished ?? 0}/{m.issues.length}</span>}
          </a>
        ))}
      </span>
      {line && <span className={`crew-line tone-${line.tone}`}>{line.text}</span>}
    </div>
  );
}

/** A running agent's own task list: done, the one it's on, and what's next. */
export function Plan({ items }: { items: PlanItem[] }) {
  const done = items.filter((i) => i.state === "done").length;
  return (
    <ol className="plan" aria-label={`Task list, ${done} of ${items.length} done`}>
      {items.map((i, n) => (
        <li key={n} className={`plan-${i.state}`}>
          {i.text}
        </li>
      ))}
    </ol>
  );
}

/** An agent working on the task right now (pulsing), or the runner holding it in its queue. */
export function WorkingBadge({ working }: { working: Working }) {
  const who = agentShort(working.agent);
  const title = working.queued ? `${working.agent}: queued, waiting for a free slot` : `${working.agent} is working on this${working.since ? ` (started ${new Date(working.since).toLocaleTimeString()})` : ""}`;
  return (
    <span className={`badge ${working.queued ? "badge-queued" : "badge-live"}`} title={title}>
      {working.queued ? `${who} queued` : `${who}${working.since ? ` · ${elapsed(working.since)}` : ""}`}
    </span>
  );
}

export function Chips({ card }: { card: Pick<Card, "status" | "labels"> & { working?: Working | null } }) {
  const badge = STATUS_BADGE[card.status];
  return (
    <>
      {card.working && <WorkingBadge working={card.working} />}
      {badge && !(card.working && card.status === "in_progress") && <span className={`badge badge-${badge.tone}`}>{badge.text}</span>}
      {card.labels
        .filter((l) => l.name !== "daily-brief")
        .map((l) => (
          <span key={l.name} className="tag" style={undefined} data-color={l.color}>
            <i style={{ background: l.color }} />
            {SOURCE_NAMES[l.name] ?? l.name}
          </span>
        ))}
    </>
  );
}

interface CardProps {
  card: Card;
  assignees: Assignee[];
  selected?: boolean;
  overlay?: boolean;
  closed?: boolean;
  onOpen: (card: Card) => void;
  onDone?: (card: Card) => void;
  onMove?: (card: Card, bucket: Bucket) => void;
  /** Snooze into Backlog until a date; needs the board's timezone for the presets. */
  onSnooze?: (card: Card, date: string) => void;
  /** Merge into another of your tasks, picked from `targets`. */
  onMerge?: (card: Card, into: Card) => void;
  targets?: Card[];
  timezone?: string;
  current?: Bucket;
}

export function CardView({ card, assignees, selected, overlay, closed, onOpen, onDone, onMove, onSnooze, onMerge, targets, timezone, current }: CardProps) {
  const assignee = assignees.find((a) => a.key === card.assignee);
  const executor = card.executor && [card.executor.model, card.executor.effort].filter(Boolean).join(" · ");
  return (
    <div
      className={`card prio-${card.priority}${selected ? " selected" : ""}${overlay ? " overlay" : ""}${card.unread ? " unread" : ""}${closed ? ` closed closed-${card.status}` : ""}`}
      data-card={card.id}
      onClick={() => onOpen(card)}
    >
      <div className="card-title">{card.title}</div>
      {card.crew && <CrewRow card={card} crew={card.crew} assignees={assignees} />}
      <div className="card-foot">
        <div className="card-meta">
          <span className="ident">{card.identifier}</span>
          <Chips card={card.crew ? { ...card, working: undefined } : card} />
          {card.scheduled && (
            <span className="tag when" title={`Moves to the top of ${BUCKET_NAMES[card.scheduled.bucket]} on ${card.scheduled.date}`}>
              ↑ {BUCKET_NAMES[card.scheduled.bucket]} {shortDate(card.scheduled.date)}
            </span>
          )}
          {card.carried ? (
            <span className="tag carried" title={`Left unfinished in Today for ${card.carried} workday${card.carried === 1 ? "" : "s"}`}>
              Carried {card.carried}d
            </span>
          ) : null}
          {card.recurring && (
            <span className="tag when" title={card.recurring.summary}>
              ↻ {card.recurring.paused ? "Paused" : card.recurring.nextRun ? `Next ${shortDate(card.recurring.nextRun)}` : card.recurring.summary}
            </span>
          )}
          <span className="spacer" />
          {executor && <span className="exec" title="Model override">{executor}</span>}
          <span className="time" title={new Date(card.activityAt).toLocaleString()}>
            {ago(card.activityAt)}
          </span>
          {assignee?.kind !== "me" && !card.crew && <Avatar assignee={assignee} />}
        </div>
        {/* On a phone the actions sit at the end of the meta row; elsewhere they float over the card on hover. */}
        {!overlay && !closed && (onDone || onMove) && (
          <div className="card-actions" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
            {onSnooze && timezone && !card.recurring && <SnoozeMenu timezone={timezone} onPick={(d) => onSnooze(card, d)} />}
            {onMove && <MoveMenu current={current} onPick={(b) => onMove(card, b)} />}
            {onMerge && targets && card.assignee === "me" && !card.recurring && <MergeMenu card={card} targets={targets} onPick={(into) => onMerge(card, into)} />}
            {onDone && (
              <button className="icon-btn" title="Done (e)" aria-label="Mark done" onClick={() => onDone(card)}>
                <CheckIcon />
              </button>
            )}
          </div>
        )}
      </div>
      {card.unread && <span className="dot" title="New activity" />}
    </div>
  );
}

export function SortableCard(props: CardProps & { disabled?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.card.id, disabled: props.disabled });
  return (
    <div
      ref={setNodeRef}
      className={`sortable${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      tabIndex={-1}
    >
      <CardView {...props} />
    </div>
  );
}

/**
 * A menu opened from a button. It's drawn on the page itself, over everything (the drawer too), below
 * the button or above it when there's no room, and always inside the window: drawn inside a card, the
 * column's scroll box used to cut it off. Clicks inside still reach the button's own handlers (a portal
 * keeps React's event tree), so a card doesn't open when you pick something.
 */
function Popover({ anchor, onClose, className, children }: { anchor: HTMLElement | null; onClose: () => void; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      if (!a.width && !a.height) return; // the button is hidden for a moment: stay put
      const { width, height } = el.getBoundingClientRect();
      const m = 8;
      const left = Math.max(m, Math.min(a.right - width, innerWidth - width - m));
      const below = a.bottom + 4;
      const above = a.top - 4 - height;
      const top = below + height <= innerHeight - m ? below : above >= m ? above : Math.max(m, innerHeight - height - m);
      setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    const sizes = new ResizeObserver(place);
    sizes.observe(el);
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    return () => {
      sizes.disconnect();
      removeEventListener("resize", place);
      removeEventListener("scroll", place, true);
    };
  }, [anchor]);
  useEffect(() => {
    const outside = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node) && close.current();
    // Escape closes the menu only, not the task behind it.
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), close.current());
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", esc, true);
    };
  }, [anchor]);
  return createPortal(
    <div ref={ref} className={`menu popover${className ? ` ${className}` : ""}`} role="menu" style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}>
      {children}
    </div>,
    document.body,
  );
}

export function MoveMenu({ current, onPick, label }: { current?: Bucket; onPick: (b: Bucket) => void; label?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <div className={`menu-wrap${open ? " open" : ""}`}>
      <button ref={ref} className={label ? "btn" : "icon-btn"} title="Move to…" aria-label="Move to" onClick={() => setOpen(!open)}>
        {label ?? <MoveIcon />}
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)}>
          {BUCKETS.map((b, i) => (
            <button
              key={b}
              role="menuitem"
              className={b === current ? "current" : ""}
              onClick={() => {
                setOpen(false);
                onPick(b);
              }}
            >
              <span>{BUCKET_NAMES[b]}</span>
              <kbd>{i + 1}</kbd>
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}

/** Snooze: park the task in Backlog and bring it back on top of Today on a date (D-25). */
export function SnoozeMenu({ timezone, onPick, label }: { timezone: string; onPick: (date: string) => void; label?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [date, setDate] = useState("");
  const ref = useRef<HTMLButtonElement>(null);
  const today = todayIn(timezone);
  const pick = (d: string) => {
    setOpen(false);
    onPick(d);
  };
  return (
    <div className={`menu-wrap${open ? " open" : ""}`}>
      <button
        ref={ref}
        className={label ? "btn" : "icon-btn"}
        title="Snooze: back on top of Today on…"
        aria-label="Snooze"
        onClick={() => (setOpen(!open), setPicking(false), setDate(""))}
      >
        {label ?? <ClockIcon />}
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)}>
          <div className="menu-head">Back on top of Today</div>
          {snoozeOptions(today).map((o) => (
            <button key={o.label} role="menuitem" onClick={() => pick(o.date)}>
              <span>{o.label}</span>
              <span className="menu-hint">{dayDate(o.date)}</span>
            </button>
          ))}
          {picking ? (
            <form className="menu-date" onSubmit={(e) => (e.preventDefault(), date && pick(date))}>
              <input type="date" autoFocus min={addDays(today, 1)} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
              <button type="submit" className="btn" disabled={!date}>
                Snooze
              </button>
            </form>
          ) : (
            <button role="menuitem" onClick={() => setPicking(true)}>
              <span>Pick a date…</span>
            </button>
          )}
        </Popover>
      )}
    </div>
  );
}

/**
 * Merge this task into another of yours, without opening it: type to find the other task, pick it,
 * then confirm (merging cancels this one). The board does the merge in code (D-56).
 */
export function MergeMenu({ card, targets, onPick, label }: { card: Pick<Card, "id" | "identifier">; targets: Card[]; onPick: (into: Card) => void; label?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Card | null>(null);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLButtonElement>(null);
  const found = open ? targets.filter((c) => c.id !== card.id && matches(c, query)).slice(0, 8) : [];
  const toggle = () => (setOpen(!open), setQuery(""), setChosen(null), setHi(0));
  const merge = (into: Card) => {
    setOpen(false);
    onPick(into);
  };
  return (
    <div className={`menu-wrap${open ? " open" : ""}`}>
      <button ref={ref} className={label ? "btn" : "icon-btn"} title="Merge into another task (m)" aria-label="Merge into" onClick={toggle}>
        {label ?? <MergeIcon />}
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)} className="merge-menu">
          {chosen ? (
            <div className="merge-confirm">
              <p>
                Merge <b>{card.identifier}</b> into <b>{chosen.identifier}</b>?
              </p>
              <p className="muted small">Its description and files join {chosen.identifier}, and {card.identifier} is cancelled.</p>
              <div className="row-end">
                <button className="btn" onClick={() => setChosen(null)}>
                  Back
                </button>
                <button className="btn primary" autoFocus onClick={() => merge(chosen)}>
                  Merge
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="menu-head">Merge {card.identifier} into…</div>
              <input
                className="menu-search"
                autoFocus
                placeholder="Search your tasks"
                value={query}
                onChange={(e) => (setQuery(e.target.value), setHi(0))}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") e.preventDefault(), setHi((h) => Math.max(0, Math.min(found.length - 1, h + (e.key === "ArrowDown" ? 1 : -1))));
                  if (e.key === "Enter" && found[hi]) e.preventDefault(), setChosen(found[hi]!);
                }}
                aria-label="Task to merge into"
              />
              <div className="merge-list">
                {found.map((c, i) => (
                  <button key={c.id} role="menuitem" className={i === hi ? "hi" : ""} onMouseEnter={() => setHi(i)} onClick={() => setChosen(c)}>
                    <span className="merge-title">{c.title}</span>
                    <span className="ident">{c.identifier}</span>
                  </button>
                ))}
                {!found.length && <p className="menu-head">No other tasks of yours match.</p>}
              </div>
            </>
          )}
        </Popover>
      )}
    </div>
  );
}

const dayDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

export const CheckIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const MoveIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path d="M3 8h9M9 4.5L12.5 8 9 11.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const ClockIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M8 5v3.2l2.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const MergeIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path d="M4 2.5v2c0 2.5 4 3.2 4 6v3M12 2.5v2c0 2.5-4 3.2-4 6M5.8 11.4L8 13.6l2.2-2.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const CloseIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
export const PlusIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

/**
 * Google accounts whose sign-in Google refused (D-36): what's paused, and a way back. Reconnecting
 * works only on the laptop's loopback address, where Google can send the sign-in back.
 */
export function GoogleBanner({ google, canReconnect }: { google: Board["google"]; canReconnect: boolean }) {
  if (!google) return null;
  const expired = google.accounts.filter((a) => a.state === "expired");
  if (!expired.length && !google.error) return null;
  return (
    <div className="alert" role="alert">
      {google.error && !google.accounts.length && <div>Google isn't connected: {google.error}. Run scripts/google-auth.sh.</div>}
      {expired.map((a) => (
        <div key={a.email} className="alert-row">
          <span>
            Google sign-in for <b>{a.email}</b> stopped working on {new Date(a.since).toLocaleDateString(undefined, { weekday: "long" })} at{" "}
            {new Date(a.since).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}.{" "}
            {a.primary ? "Meeting notes, calendar, email and Drive from it are paused." : "Email and Drive from it are paused."}
          </span>
          {canReconnect ? (
            <a className="btn" href={`/google/connect?account=${encodeURIComponent(a.email)}`}>
              Reconnect
            </a>
          ) : (
            <span className="alert-hint">Reconnect from the board on your computer.</span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Glean sign-in (D-38): a banner when Pennyworth isn't signed in to Glean yet, or Glean stopped
 * accepting its sign-in, with Connect / Reconnect on the laptop (Glean returns to its loopback address).
 */
export function GleanBanner({ glean, canConnect }: { glean: Board["glean"]; canConnect: boolean }) {
  if (!glean?.configured || (glean.state !== "missing" && glean.state !== "expired")) return null;
  const since = new Date(glean.since);
  return (
    <div className="alert" role="alert">
      <div className="alert-row">
        <span>
          {glean.state === "missing" ? (
            <>Glean isn't connected yet. The Assistant can't search company knowledge until it is.</>
          ) : (
            <>
              Glean sign-in stopped working on {since.toLocaleDateString(undefined, { weekday: "long" })} at{" "}
              {since.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}. The Assistant's company search is paused.
            </>
          )}
        </span>
        {canConnect ? (
          <a className="btn" href="/glean/connect">
            {glean.state === "missing" ? "Connect" : "Reconnect"}
          </a>
        ) : (
          <span className="alert-hint">Connect from the board on your computer.</span>
        )}
      </div>
    </div>
  );
}

/**
 * Grafana sign-in: a banner when Pennyworth isn't signed in to Grafana yet, or Grafana stopped
 * accepting its sign-in, with Connect / Reconnect on the laptop (Grafana returns to its loopback address).
 */
export function GrafanaBanner({ grafana, canConnect }: { grafana: Board["grafana"]; canConnect: boolean }) {
  if (!grafana?.configured || (grafana.state !== "missing" && grafana.state !== "expired")) return null;
  const since = new Date(grafana.since);
  return (
    <div className="alert" role="alert">
      <div className="alert-row">
        <span>
          {grafana.state === "missing" ? (
            <>Grafana isn't connected yet. The Engineers can't read logs and metrics until it is.</>
          ) : (
            <>
              Grafana sign-in stopped working on {since.toLocaleDateString(undefined, { weekday: "long" })} at{" "}
              {since.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}. The Engineers can't read logs and metrics.
            </>
          )}
        </span>
        {canConnect ? (
          <a className="btn" href="/grafana/connect">
            {grafana.state === "missing" ? "Connect" : "Reconnect"}
          </a>
        ) : (
          <span className="alert-hint">Connect from the board on your computer.</span>
        )}
      </div>
    </div>
  );
}

/**
 * Telegram sign-in (D-37): a banner when Pennyworth isn't signed in yet or Telegram ended its session,
 * with a small form (phone, the code Telegram sends, then the 2FA password if the account has one).
 * Only on the laptop's loopback address, like Google's Reconnect.
 */
export function TelegramBanner({ telegram, canSignIn }: { telegram: Board["telegram"]; canSignIn: boolean }) {
  const [form, setForm] = useState<{ step: "phone" | "code" | "password"; loginId?: string; viaApp?: boolean } | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!telegram?.configured || done || (telegram.state !== "missing" && telegram.state !== "ended")) {
    return done ? (
      <div className="alert ok" role="status">
        <div className="alert-row">
          <span>Telegram is connected as {done}. New mentions and DMs show up within minutes.</span>
          <button className="btn" onClick={() => setDone(null)}>
            OK
          </button>
        </div>
      </div>
    ) : null;
  }
  const ended = telegram.state === "ended";
  const since = new Date(telegram.since);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r =
        form.step === "phone" ? await api.telegramStart(value.trim()) : form.step === "code" ? await api.telegramCode(form.loginId!, value.trim()) : await api.telegramPassword(form.loginId!, value);
      setValue("");
      if (r.step === "done") {
        setForm(null);
        setDone(r.account.username ? `@${r.account.username}` : r.account.name);
      } else setForm({ step: r.step, loginId: r.login_id, viaApp: r.step === "code" ? r.via_app : form.viaApp });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const prompts = {
    phone: { label: "Phone number of your Telegram account", type: "tel", placeholder: "+34 600 000 000", auto: "tel" },
    code: { label: form?.viaApp ? "The code Telegram just sent to your Telegram app" : "The code Telegram just sent you", type: "text", placeholder: "12345", auto: "one-time-code" },
    password: { label: "Your Telegram 2FA password", type: "password", placeholder: "", auto: "current-password" },
  };
  const p = form && prompts[form.step];
  return (
    <div className="alert" role="alert">
      <div className="alert-row">
        <span>
          {ended ? (
            <>
              Telegram ended Pennyworth's session on {since.toLocaleDateString(undefined, { weekday: "long" })} at{" "}
              {since.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}. Telegram mentions, DMs and reads are paused.
            </>
          ) : (
            <>Telegram isn't connected yet. Sign in once to get mentions and DMs as tasks.</>
          )}
        </span>
        {!canSignIn ? (
          <span className="alert-hint">Sign in from the board on your computer.</span>
        ) : (
          !form && (
            <button className="btn" onClick={() => setForm({ step: "phone" })}>
              {ended ? "Reconnect" : "Connect"}
            </button>
          )
        )}
      </div>
      {form && p && (
        <form className="alert-row" onSubmit={submit}>
          <label className="alert-field">
            <span>{p.label}</span>
            <input autoFocus type={p.type} inputMode={form.step === "code" ? "numeric" : undefined} autoComplete={p.auto} placeholder={p.placeholder} value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} />
          </label>
          <button className="btn primary" type="submit" disabled={busy || !value.trim()}>
            {busy ? "…" : form.step === "password" ? "Sign in" : "Next"}
          </button>
          <button className="btn" type="button" onClick={() => (setForm(null), setValue(""), setError(null))} disabled={busy}>
            Cancel
          </button>
          {error && <span className="alert-error">{error}</span>}
        </form>
      )}
    </div>
  );
}

/**
 * Off-machine backups (D-58): a banner when they aren't set up, or none has worked for a day, so
 * tasks that live only on this laptop never go unnoticed. Fixing it happens in a terminal.
 */
export function BackupBanner({ backup }: { backup: Board["backup"] }) {
  if (!backup?.stale) return null;
  const last = backup.lastSuccess ? new Date(backup.lastSuccess) : null;
  return (
    <div className="alert" role="alert">
      <div className="alert-row">
        <span>
          {backup.state === "never" || backup.state === "missing" || !last ? (
            <>Tasks aren't backed up off this computer yet.</>
          ) : (
            <>
              The last off-machine backup was on {last.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
              {backup.error ? `: ${backup.error}` : "."}
            </>
          )}
        </span>
        <span className="alert-hint">
          {backup.state === "never" ? (
            <>
              Install the backup timer, then run <code>scripts/backup.sh --offsite</code>.
            </>
          ) : backup.state === "missing" ? (
            <>
              Set up <code>backup/restic.env</code> in the secrets directory, then run <code>scripts/backup.sh --init</code>.
            </>
          ) : (
            <>
              See <code>journalctl --user -u pennyworth-backup</code>.
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * ClickHouse sign-in (D-57): a banner when Pennyworth isn't signed in to ClickHouse Cloud yet, or it
 * stopped accepting the sign-in, with Connect / Reconnect on the laptop (it returns to its loopback address).
 */
export function ClickHouseBanner({ clickhouse, canConnect }: { clickhouse: Board["clickhouse"]; canConnect: boolean }) {
  if (!clickhouse?.configured || (clickhouse.state !== "missing" && clickhouse.state !== "expired")) return null;
  const since = new Date(clickhouse.since);
  return (
    <div className="alert" role="alert">
      <div className="alert-row">
        <span>
          {clickhouse.state === "missing" ? (
            <>ClickHouse isn't connected yet. The Engineers can't query it until it is.</>
          ) : (
            <>
              ClickHouse sign-in stopped working on {since.toLocaleDateString(undefined, { weekday: "long" })} at{" "}
              {since.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}. The Engineers can't query it.
            </>
          )}
        </span>
        {canConnect ? (
          <a className="btn" href="/clickhouse/connect">
            {clickhouse.state === "missing" ? "Connect" : "Reconnect"}
          </a>
        ) : (
          <span className="alert-hint">Connect from the board on your computer.</span>
        )}
      </div>
    </div>
  );
}
