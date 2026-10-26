import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "./api";
import { BUCKETS, BUCKET_NAMES, type Assignee, type Board, type Bucket, type Card, type CrewMember, type CrewState, type Working } from "./types";
import { SOURCE_NAMES, STATUS_BADGE, agentShort, ago, elapsed, shortDate, shortName } from "./util";

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
  current?: Bucket;
}

export function CardView({ card, assignees, selected, overlay, closed, onOpen, onDone, onMove, current }: CardProps) {
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
      {card.unread && <span className="dot" title="New activity" />}
      {!overlay && !closed && (onDone || onMove) && (
        <div className="card-actions" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          {onMove && <MoveMenu current={current} onPick={(b) => onMove(card, b)} />}
          {onDone && (
            <button className="icon-btn" title="Done (e)" aria-label="Mark done" onClick={() => onDone(card)}>
              <CheckIcon />
            </button>
          )}
        </div>
      )}
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

export function MoveMenu({ current, onPick, label }: { current?: Bucket; onPick: (b: Bucket) => void; label?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className={label ? "btn" : "icon-btn"} title="Move to…" aria-label="Move to" onClick={() => setOpen(!open)}>
        {label ?? <MoveIcon />}
      </button>
      {open && (
        <div className="menu" role="menu">
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
        </div>
      )}
    </div>
  );
}

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
