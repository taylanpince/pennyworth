import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PairRequired, api, type Session } from "./api";
import { CardView, PlusIcon, SortableCard } from "./components";
import { Drawer } from "./Drawer";
import { Markdown } from "./markdown";
import { PairScreen, PhonePanel } from "./Pairing";
import { BUCKETS, BUCKET_NAMES, type Board, type Bucket, type Card } from "./types";
import { matches } from "./util";

type Items = Record<Bucket, Card[]>;
type Route = { kind: "board" } | { kind: "task"; ref: string } | { kind: "brief" } | { kind: "help" } | { kind: "phone" } | { kind: "pair"; code: string };

const HINTS: Record<Bucket, string> = {
  triage: "New tasks land here",
  today: "",
  tomorrow: "Rolls into Today",
  later: "This week or so",
  backlog: "Someday",
};

/**
 * What a dragged card is over: a card under the pointer (closest one), else the column under the
 * pointer. closestCorners alone prefers a small card in the old column over a tall empty one.
 */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (!hits.length) return rectIntersection(args);
  const cards = hits.filter((h) => !(BUCKETS as string[]).includes(String(h.id)));
  if (!cards.length) return hits;
  return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((d) => cards.some((c) => c.id === d.id)) });
};

function parseRoute(): Route {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  if (h.startsWith("t/")) return { kind: "task", ref: h.slice(2) };
  if (h === "brief") return { kind: "brief" };
  if (h === "help") return { kind: "help" };
  if (h === "phone") return { kind: "phone" };
  if (h.startsWith("pair/")) return { kind: "pair", code: h.slice(5) };
  return { kind: "board" };
}
const go = (hash: string) => {
  if (location.hash !== hash) location.hash = hash;
};

function useMedia(query: string) {
  const [on, setOn] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const f = () => setOn(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [query]);
  return on;
}

interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

export function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [needsPairing, setNeedsPairing] = useState(false);
  const [items, setItems] = useState<Items | null>(null);
  const [error, setError] = useState("");
  const [route, setRoute] = useState<Route>(parseRoute);
  const [query, setQuery] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [showRecurring, setShowRecurring] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<Bucket>("today");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const mobile = useMedia("(max-width: 860px)");
  const holdUntil = useRef(0); // ignore polls briefly after a local change, so cards don't jump back
  const itemsRef = useRef<Items | null>(null);
  itemsRef.current = items;
  const dragFrom = useRef<Bucket | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLInputElement>(null);

  const toast = useCallback((text: string, action?: Toast["action"]) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 7000 : 3500);
  }, []);

  const seq = useRef(0); // only the latest board request counts (an old 401 must not undo pairing)
  const refresh = useCallback(async (force = false) => {
    const n = ++seq.current;
    try {
      const b = await api.board();
      if (n !== seq.current) return;
      setBoard(b);
      setError("");
      setNeedsPairing(false);
      if (force || Date.now() > holdUntil.current) setItems(b.buckets);
    } catch (e) {
      if (n !== seq.current) return;
      if (e instanceof PairRequired) setNeedsPairing(true);
      else setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    api.session().then(setSession, () => {});
    void refresh(true);
    const t = setInterval(() => document.visibilityState === "visible" && !dragFrom.current && void refresh(), 10_000);
    const vis = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", vis);
    const hash = () => setRoute(parseRoute());
    window.addEventListener("hashchange", hash);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener("hashchange", hash);
    };
  }, [refresh]);

  // Mobile starts on Triage when there's something to sort, else Today.
  const startedTab = useRef(false);
  useEffect(() => {
    if (items && !startedTab.current) {
      startedTab.current = true;
      setTab(items.triage.length ? "triage" : "today");
    }
  }, [items]);

  const hold = () => (holdUntil.current = Date.now() + 4000);
  const bucketOf = (id: string, src = itemsRef.current): Bucket | undefined => (src ? BUCKETS.find((b) => src[b].some((c) => c.id === id)) : undefined);

  // ---------------------------------------------------------------- actions

  async function moveCard(id: string, to: Bucket, position: "top" | "bottom" = "top") {
    const cur = itemsRef.current;
    const from = bucketOf(id);
    if (!cur || !from) return;
    const card = cur[from].find((c) => c.id === id)!;
    if (from !== to) {
      hold();
      setItems({ ...cur, [from]: cur[from].filter((c) => c.id !== id), [to]: position === "top" ? [card, ...cur[to]] : [...cur[to], card] });
    }
    try {
      await api.move(id, to, position);
      if (from !== to) toast(`Moved to ${BUCKET_NAMES[to]}`);
    } catch (e) {
      toast(`Couldn't move: ${(e as Error).message}`);
      void refresh(true);
    }
  }

  async function reorder(id: string, delta: number) {
    const cur = itemsRef.current;
    const b = bucketOf(id);
    if (!cur || !b) return;
    const list = cur[b];
    const i = list.findIndex((c) => c.id === id);
    const j = Math.max(0, Math.min(list.length - 1, i + delta));
    if (i === j) return;
    const next = arrayMove(list, i, j);
    hold();
    setItems({ ...cur, [b]: next });
    await api.order(b, next.map((c) => c.id)).catch(() => refresh(true));
  }

  async function markDone(card: Card) {
    const cur = itemsRef.current;
    const b = bucketOf(card.id);
    if (cur && b) hold(), setItems({ ...cur, [b]: cur[b].filter((c) => c.id !== card.id) });
    try {
      await api.update(card.id, { status: "done" });
      toast(`${card.identifier} done`, {
        label: "Undo",
        run: () => void api.update(card.id, { status: card.status === "in_progress" ? "in_progress" : "todo" }).then(() => refresh(true)),
      });
      void refresh();
    } catch (e) {
      toast(`Couldn't update: ${(e as Error).message}`);
      void refresh(true);
    }
  }

  /** All of Today's carried-over tasks at once (D-28): keep them for today, or move them on. */
  async function carriedAction(action: "keep" | "tomorrow" | "later") {
    const cur = itemsRef.current;
    if (!cur) return;
    const carried = cur.today.filter((c) => c.carried);
    hold();
    if (action === "keep") setItems({ ...cur, today: cur.today.map((c) => ({ ...c, carried: undefined })) });
    else setItems({ ...cur, today: cur.today.filter((c) => !c.carried), [action]: [...carried.map((c) => ({ ...c, carried: undefined })), ...cur[action]] });
    try {
      const { count } = await api.carried(action);
      toast(action === "keep" ? "Kept for today" : `Moved ${count} to ${BUCKET_NAMES[action]}`);
      void refresh(true);
    } catch (e) {
      toast(`Couldn't update: ${(e as Error).message}`);
      void refresh(true);
    }
  }

  async function addTask(title: string, bucket: Bucket) {
    try {
      const t = await api.create(title, bucket);
      toast(`Added ${t.identifier} to ${BUCKET_NAMES[bucket]}`);
      await refresh(true);
    } catch (e) {
      toast(`Couldn't add: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- drag and drop

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
    dragFrom.current = bucketOf(String(e.active.id)) ?? null;
  }

  function containerOf(id: string): Bucket | undefined {
    return (BUCKETS as string[]).includes(id) ? (id as Bucket) : bucketOf(id);
  }

  function onDragOver(e: DragOverEvent) {
    const over = e.over && String(e.over.id);
    const id = String(e.active.id);
    const cur = itemsRef.current;
    if (!over || !cur) return;
    const from = bucketOf(id);
    const to = containerOf(over);
    if (!from || !to || from === to) return;
    const card = cur[from].find((c) => c.id === id)!;
    const idx = cur[to].findIndex((c) => c.id === over);
    const target = [...cur[to]];
    target.splice(idx < 0 ? target.length : idx, 0, card);
    setItems({ ...cur, [from]: cur[from].filter((c) => c.id !== id), [to]: target });
  }

  function onDragEnd(e: DragEndEvent) {
    const id = String(e.active.id);
    const over = e.over && String(e.over.id);
    const from = dragFrom.current;
    setActiveId(null);
    dragFrom.current = null;
    let cur = itemsRef.current;
    if (!cur || !over) return void refresh(true);
    const b = bucketOf(id);
    if (!b) return;
    const list = cur[b];
    const oldIndex = list.findIndex((c) => c.id === id);
    const newIndex = list.findIndex((c) => c.id === over);
    if (newIndex >= 0 && oldIndex !== newIndex) {
      cur = { ...cur, [b]: arrayMove(list, oldIndex, newIndex) };
      setItems(cur);
    }
    hold();
    void api.order(b, cur[b].map((c) => c.id)).catch(() => refresh(true));
    if (from && from !== b) toast(`Moved to ${BUCKET_NAMES[b]}`);
  }

  // ---------------------------------------------------------------- keyboard

  const visibleBuckets: Bucket[] = mobile ? [tab] : BUCKETS;
  const filtered = useMemo(() => {
    if (!items) return null;
    return Object.fromEntries(BUCKETS.map((b) => [b, items[b].filter((c) => matches(c, query))])) as Items;
  }, [items, query]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      const typing = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
      if (e.key === "Escape") {
        if (typing) return el.blur();
        if (route.kind !== "board") return go("#/");
        if (query) return setQuery("");
        return setSelected(null);
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (route.kind === "task" || route.kind === "brief") return;
      const lists = filtered;
      if (!lists) return;
      const cols = visibleBuckets;
      const pos = () => {
        for (const b of cols) {
          const i = lists[b].findIndex((c) => c.id === selected);
          if (i >= 0) return { b, i };
        }
        return undefined;
      };
      const select = (card: Card | undefined) => {
        if (!card) return;
        setSelected(card.id);
        requestAnimationFrame(() => document.querySelector(`[data-card="${card.id}"]`)?.scrollIntoView({ block: "nearest" }));
      };
      const p = pos();
      const k = e.key;
      if (k === "/") return e.preventDefault(), searchRef.current?.focus();
      if (k === "c" || k === "n") return e.preventDefault(), mobile && setTab("triage"), setTimeout(() => addRef.current?.focus(), 0);
      if (k === "b") return go("#/brief");
      if (k === "?") return go("#/help");
      if (k === "d") return setShowDone((s) => !s);
      if (k === "r") return setShowRecurring((s) => !s);
      if (k === "j" || k === "ArrowDown") {
        e.preventDefault();
        if (e.shiftKey && p) return void reorder(lists[p.b][p.i]!.id, 1);
        if (!p) return select(cols.map((b) => lists[b][0]).find(Boolean));
        return select(lists[p.b][p.i + 1]);
      }
      if (k === "k" || k === "ArrowUp") {
        e.preventDefault();
        if (e.shiftKey && p) return void reorder(lists[p.b][p.i]!.id, -1);
        if (p) return select(lists[p.b][p.i - 1]);
        return;
      }
      if (k === "J" && p) return e.preventDefault(), void reorder(lists[p.b][p.i]!.id, 1);
      if (k === "K" && p) return e.preventDefault(), void reorder(lists[p.b][p.i]!.id, -1);
      if ((k === "h" || k === "ArrowLeft" || k === "l" || k === "ArrowRight") && !mobile) {
        e.preventDefault();
        const dir = k === "h" || k === "ArrowLeft" ? -1 : 1;
        let ci = p ? cols.indexOf(p.b) : 0;
        for (let n = 0; n < cols.length; n++) {
          ci += dir;
          if (ci < 0 || ci >= cols.length) return;
          const list = lists[cols[ci]!];
          if (list.length) return select(list[Math.min(p?.i ?? 0, list.length - 1)]);
        }
        return;
      }
      if (!p) return;
      const card = lists[p.b][p.i]!;
      if (k === "Enter" || k === "o") return go(`#/t/${card.identifier}`);
      if (k === "e" || k === "x") {
        const next = lists[p.b][p.i + 1] ?? lists[p.b][p.i - 1];
        setSelected(next?.id ?? null);
        return void markDone(card);
      }
      const n = Number(k);
      if (n >= 1 && n <= BUCKETS.length) {
        const next = lists[p.b][p.i + 1] ?? lists[p.b][p.i - 1];
        if (BUCKETS[n - 1] !== p.b && mobile) setSelected(next?.id ?? null);
        return void moveCard(card.id, BUCKETS[n - 1]!);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------------------------------------------------------------- render

  const paired = useCallback(() => {
    setRoute({ kind: "board" }); // the pairing link was replaced in history without a hashchange
    setNeedsPairing(false);
    void api.session().then(setSession);
    void refresh(true);
  }, [refresh]);
  if (route.kind === "pair" && session?.mode !== "local") return <PairScreen code={route.code} onPaired={paired} />;
  if (needsPairing) return <PairScreen onPaired={paired} />;

  if (!board || !items || !filtered)
    return <div className="splash">{error ? <>Can't reach the board: {error}</> : <span className="spinner" />}</div>;

  const active = activeId ? BUCKETS.flatMap((b) => items[b]).find((c) => c.id === activeId) : undefined;
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, items[b].length])) as Record<Bucket, number>;
  const openCard = (c: Card) => {
    setSelected(c.id);
    go(`#/t/${c.identifier}`);
  };

  return (
    <div className={`app${mobile ? " mobile" : ""}`}>
      <header className="topbar">
        <a className="brand" href="#/" onClick={() => setQuery("")}>
          <img src="/icon.png" alt="" />
          <span>Pennyworth</span>
        </a>
        <div className="search">
          <input ref={searchRef} type="search" placeholder="Search  /" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <span className="spacer" />
        {board.brief && (
          <a className="btn" href="#/brief" title="Today's brief (b)">
            Brief
          </a>
        )}
        {board.recurring.length > 0 && (
          <button className={`btn${showRecurring ? " on" : ""}`} onClick={() => setShowRecurring(!showRecurring)} title="Recurring tasks (r)">
            Recurring
          </button>
        )}
        <button className={`btn${showDone ? " on" : ""}`} onClick={() => setShowDone(!showDone)} title="Recently done (d)">
          Done
        </button>
        {session?.mode === "local" && session.lan && !mobile && (
          <a className="btn" href="#/phone" title="Open the board on your phone">
            Phone
          </a>
        )}
        {!mobile && (
          <a className="icon-btn" href="#/help" title="Keyboard shortcuts (?)">
            ?
          </a>
        )}
      </header>

      {error && <div className="offline">Offline: {error}. Retrying…</div>}

      {mobile && (
        <nav className="tabs">
          {BUCKETS.map((b) => (
            <button key={b} className={b === tab ? "on" : ""} onClick={() => setTab(b)}>
              {BUCKET_NAMES[b]}
              {counts[b] > 0 && <span className="count">{counts[b]}</span>}
            </button>
          ))}
        </nav>
      )}

      <main className="columns">
        <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => (setActiveId(null), (dragFrom.current = null), void refresh(true))}>
          {visibleBuckets.map((b) => (
            <Column
              key={b}
              bucket={b}
              cards={filtered[b]}
              total={counts[b]}
              board={board}
              selected={selected}
              dragDisabled={!!query}
              onOpen={openCard}
              onDone={markDone}
              onMove={(c, to) => void moveCard(c.id, to)}
              onAdd={(title) => addTask(title, b)}
              onCarried={b === "today" ? (action) => void carriedAction(action) : undefined}
              addRef={b === "triage" ? addRef : undefined}
              timezone={board.timezone}
            />
          ))}
          <DragOverlay dropAnimation={null}>{active && <CardView card={active} assignees={board.assignees} overlay onOpen={() => {}} />}</DragOverlay>
        </DndContext>
        {showRecurring && (
          <section className="column column-done">
            <header className="col-head">
              <h2>Recurring</h2>
              <span className="count">{board.recurring.length}</span>
              <span className="hint">Runs land on top of Today</span>
            </header>
            <div className="col-body">
              {board.recurring.filter((c) => matches(c, query)).map((c) => (
                <CardView key={c.id} card={c} assignees={board.assignees} onOpen={openCard} />
              ))}
              {!board.recurring.length && <p className="empty">Nothing repeats yet. Open a task and use Repeats.</p>}
            </div>
          </section>
        )}
        {showDone && (
          <section className="column column-done">
            <header className="col-head">
              <h2>Done</h2>
              <span className="count">{board.done.length}</span>
              <span className="hint">Last 48 hours</span>
            </header>
            <div className="col-body">
              {board.done.filter((c) => matches(c, query)).map((c) => (
                <CardView key={c.id} card={c} assignees={board.assignees} closed onOpen={openCard} />
              ))}
              {!board.done.length && <p className="empty">Nothing closed recently.</p>}
            </div>
          </section>
        )}
      </main>

      {route.kind === "task" && (
        <Drawer
          key={route.ref}
          refId={route.ref}
          board={board}
          onClose={() => go("#/")}
          onChanged={() => void refresh(true)}
          onMove={(id, b) => moveCard(id, b)}
          toast={toast}
        />
      )}
      {route.kind === "brief" && board.brief && (
        <div className="drawer-backdrop" onPointerDown={(e) => e.target === e.currentTarget && go("#/")}>
          <aside className="drawer brief" role="dialog" aria-label="Brief">
            <header className="drawer-head">
              <span className="ident">{board.brief.identifier}</span>
              <span className="spacer" />
              <button className="btn" onClick={() => void api.update(board.brief!.id, { status: "done" }).then(() => (go("#/"), refresh(true)))}>
                Mark read
              </button>
              <a className="icon-btn" href="#/" aria-label="Close">
                ✕
              </a>
            </header>
            <div className="drawer-scroll">
              <Markdown text={board.brief.description} prefix={board.prefix} className="brief-md" />
            </div>
          </aside>
        </div>
      )}
      {route.kind === "help" && <Help />}
      {route.kind === "phone" && <PhonePanel onClose={() => go("#/")} />}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span>{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run();
                  setToasts((x) => x.filter((y) => y.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface ColumnProps {
  bucket: Bucket;
  cards: Card[];
  total: number;
  board: Board;
  selected: string | null;
  dragDisabled: boolean;
  onOpen: (c: Card) => void;
  onDone: (c: Card) => void;
  onMove: (c: Card, b: Bucket) => void;
  onAdd: (title: string) => Promise<void>;
  onCarried?: (action: "keep" | "tomorrow" | "later") => void;
  addRef?: React.RefObject<HTMLInputElement | null>;
  timezone: string;
}

function Column({ bucket, cards, total, board, selected, dragDisabled, onOpen, onDone, onMove, onAdd, onCarried, addRef, timezone }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: bucket });
  const [adding, setAdding] = useState(bucket === "triage");
  const [title, setTitle] = useState("");
  const hint =
    bucket === "today"
      ? new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", timeZone: timezone })
      : bucket === "tomorrow" && !board.rollsTomorrow
        ? `Rolls into Today on ${new Date(`${board.rollsOn}T12:00:00`).toLocaleDateString(undefined, { weekday: "long" })}`
        : HINTS[bucket];
  const carried = onCarried ? cards.filter((c) => c.carried).length : 0;
  async function submit() {
    const t = title.trim();
    if (!t) return;
    setTitle("");
    await onAdd(t);
  }
  return (
    <section className={`column column-${bucket}${isOver ? " over" : ""}${bucket === "triage" && total ? " has-items" : ""}`}>
      <header className="col-head">
        <h2>{BUCKET_NAMES[bucket]}</h2>
        <span className="count">{total}</span>
        <span className="hint">{hint}</span>
        <span className="spacer" />
        {bucket !== "triage" && (
          <button className="icon-btn subtle" title={`Add to ${BUCKET_NAMES[bucket]}`} aria-label={`Add to ${BUCKET_NAMES[bucket]}`} onClick={() => setAdding(!adding)}>
            <PlusIcon />
          </button>
        )}
      </header>
      {adding && (
        <form
          className="quick-add"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            ref={addRef}
            value={title}
            placeholder={bucket === "triage" ? "Add a task…  c" : `Add to ${BUCKET_NAMES[bucket]}…`}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setTitle("");
                (e.target as HTMLInputElement).blur();
                if (bucket !== "triage") setAdding(false);
              }
            }}
          />
        </form>
      )}
      <div className="col-body" ref={setNodeRef}>
        {carried > 0 && (
          <div className="carried-bar">
            <span title="Left unfinished from earlier days: keep them for today, or move them on">
              Carried over · <b>{carried}</b>
            </span>
            <span className="spacer" />
            <button className="btn" title="Keep them for today" onClick={() => onCarried!("keep")}>
              Keep
            </button>
            <button className="btn" onClick={() => onCarried!("tomorrow")}>
              → Tomorrow
            </button>
            <button className="btn" onClick={() => onCarried!("later")}>
              → Later
            </button>
          </div>
        )}
        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {cards.map((c) => (
            <SortableCard key={c.id} card={c} assignees={board.assignees} selected={c.id === selected} disabled={dragDisabled} onOpen={onOpen} onDone={onDone} onMove={onMove} current={bucket} />
          ))}
        </SortableContext>
        {!cards.length && <p className="empty">{total ? "No matches." : bucket === "triage" ? "All sorted." : "Nothing here."}</p>}
      </div>
    </section>
  );
}

function Help() {
  const rows: [string, string][] = [
    ["j / k  ↓ ↑", "Select next / previous"],
    ["h / l  ← →", "Previous / next column"],
    ["Enter", "Open task"],
    ["e", "Done"],
    ["1 – 5", "Move to Triage, Today, Tomorrow, Later, Backlog"],
    ["J / K  ⇧↓ ⇧↑", "Move down / up in the column"],
    ["c", "New task (lands in Triage)"],
    ["/", "Search"],
    ["b", "Today's brief"],
    ["d", "Show recently done"],
    ["r", "Show recurring tasks"],
    ["⌘↵", "Send reply / save description"],
    ["Esc", "Close"],
  ];
  return (
    <div className="drawer-backdrop center" onPointerDown={(e) => e.target === e.currentTarget && go("#/")}>
      <div className="help" role="dialog" aria-label="Keyboard shortcuts">
        <h2>Keyboard</h2>
        <dl>
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="muted small">Drag cards to rank them; Tomorrow moves into Today at the start of the next workday, below what's left over. Open a task to bring it back on a date or make it repeat.</p>
      </div>
    </div>
  );
}
