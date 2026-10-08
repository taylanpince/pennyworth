import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BUCKETS, BUCKET_NAMES, type Assignee, type Bucket, type Card } from "./types";
import { SOURCE_NAMES, STATUS_BADGE, ago, shortDate, shortName } from "./util";

export function Avatar({ assignee }: { assignee: Assignee | undefined }) {
  if (!assignee) return null;
  const tone = assignee.kind === "me" ? "me" : assignee.kind === "assistant" ? "assistant" : assignee.engine ?? "agent";
  const letter = assignee.kind === "me" ? "Y" : shortName(assignee).slice(0, 1).toUpperCase();
  return (
    <span className={`avatar avatar-${tone}`} title={assignee.name}>
      {letter}
    </span>
  );
}

export function Chips({ card }: { card: Pick<Card, "status" | "labels"> }) {
  const badge = STATUS_BADGE[card.status];
  return (
    <>
      {badge && <span className={`badge badge-${badge.tone}`}>{badge.text}</span>}
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
      <div className="card-meta">
        <span className="ident">{card.identifier}</span>
        <Chips card={card} />
        {card.scheduled && (
          <span className="tag when" title={`Moves to the top of ${BUCKET_NAMES[card.scheduled.bucket]} on ${card.scheduled.date}`}>
            ↑ {BUCKET_NAMES[card.scheduled.bucket]} {shortDate(card.scheduled.date)}
          </span>
        )}
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
        {assignee?.kind !== "me" && <Avatar assignee={assignee} />}
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
