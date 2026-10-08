// Deterministic part of the Telegram Scout: walks the allowlisted chats from a per-chat cursor
// and picks the messages that may need the user (mentions by handle or name, replies to the
// user's messages, DMs, and the user's own messages for commitments). The agent only judges.
//
// The upstream server is slow (seconds to tens of seconds per call), so scanning runs in the
// background (refresh) and the agent's tool returns what is ready (candidates). The state file
// holds cursors and message IDs only; message text lives in memory and is re-read after a restart.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Message {
  chat_ref: string;
  message_id: number;
  timestamp: string | null;
  text: string;
  reply_to_message_id: number | null;
  display_name: string | null;
}

export interface Chat {
  chat_ref: string;
  title: string;
  type: string;
}

/** Calls an upstream Telegram MCP tool and returns its structured `result`. */
export type Upstream = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface Me {
  /** Display-name prefixes of the user's own messages ("Dana Whitfield" matches "Dana Whitfield | Globex"). */
  names: string[];
  /** Telegram usernames without "@". */
  handles: string[];
  /** Words people use for the user in text ("dana"), matched as whole words. */
  aliases: string[];
}

export type Kind = "mention" | "reply" | "dm" | "own";

interface ChatState {
  cursor: number; // highest message ID scanned
  floor: number; // lowest message ID scanned: below it, authorship is unknown
  mine: number[]; // the user's message IDs seen (bounded)
}

interface Pending {
  chat_ref: string;
  message_id: number;
  kinds: Kind[];
  handed_out: number;
}

export interface State {
  chats: Record<string, ChatState>;
  pending: Pending[];
}

const MINE_KEEP = 500;
const MAX_HANDOUTS = 3; // a candidate the agent never acknowledges is dropped after this many runs
const PAGE = 100; // get_new_messages page size (server cap)
const MAX_PAGES = 10;
const CONTEXT_BEFORE = 5;
const AFTER_KEEP = 30;
const WINDOW_PAGES = 3; // pages read per chat to give its candidates context
const MAX_LOOKUPS = 10; // single-message lookups (replied-to messages) per refresh

export function loadState(path: string): State {
  if (!existsSync(path)) return { chats: {}, pending: [] };
  return JSON.parse(readFileSync(path, "utf8")) as State;
}

export function saveState(path: string, state: State): void {
  const tmp = join(dirname(path), `.scout.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function isMine(m: Pick<Message, "display_name">, me: Me): boolean {
  const name = (m.display_name ?? "").trim().toLowerCase();
  return me.names.some((n) => {
    const p = n.trim().toLowerCase();
    return p !== "" && (name === p || name.startsWith(`${p} `));
  });
}

/** Mentions by @handle or by alias as a whole word, case-insensitive. */
export function mentionsMe(text: string, me: Me): boolean {
  const handles = me.handles.filter(Boolean).map((h) => `@${escape(h.replace(/^@/, ""))}(?![\\p{L}\\p{N}_])`);
  const aliases = me.aliases.filter(Boolean).map((a) => `(?<![\\p{L}\\p{N}_@])${escape(a)}(?![\\p{L}\\p{N}_])`);
  const parts = [...handles, ...aliases];
  return parts.length > 0 && new RegExp(parts.join("|"), "iu").test(text);
}

const isDm = (chat: Chat) => !["chat", "channel"].includes(chat.type);
const asList = <T>(r: unknown) => (Array.isArray(r) ? (r as T[]) : []);
const key = (chat_ref: string, message_id: number) => `${chat_ref}:${message_id}`;
const byId = (a: Message, b: Message) => a.message_id - b.message_id;

export class Scout {
  private state: State;
  private views = new Map<string, ReturnType<Scout["view"]>>();
  private chatList: Chat[] = [];
  private refreshing?: Promise<void>;
  private lastRefresh?: { at: number; errors: string[] };

  constructor(
    private readonly upstream: Upstream,
    private readonly me: Me,
    private readonly statePath: string,
    private readonly lookbackHours = 24,
    private readonly now: () => number = Date.now,
  ) {
    this.state = loadState(statePath);
  }

  private save() {
    saveState(this.statePath, this.state);
  }

  /** Scan for new messages and prepare candidates. Concurrent callers share one refresh. */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const errors: string[] = [];
    const chats = asList<Chat>(await this.upstream("list_allowed_chats", {}));
    this.chatList = chats;
    const live = new Set(chats.map((c) => c.chat_ref));
    // Refs change when the user edits the allowlist; old ones stop working.
    for (const ref of Object.keys(this.state.chats)) if (!live.has(ref)) delete this.state.chats[ref];
    this.state.pending = this.state.pending.filter((p) => live.has(p.chat_ref));

    const lookups = { left: MAX_LOOKUPS };
    const active = new Set<string>();
    for (const chat of chats) {
      try {
        const msgs = await this.newMessages(chat);
        if (msgs.length) active.add(chat.chat_ref);
        await this.classify(chat, msgs, lookups);
      } catch (err) {
        errors.push(`${chat.title}: ${String((err as Error).message).slice(0, 200)}`);
      }
    }
    this.save();

    // Context for candidates in chats with new messages (what came after may have changed),
    // and for candidates not prepared yet (new, or after a restart).
    for (const chat of chats) {
      const pending = this.state.pending.filter((p) => p.chat_ref === chat.chat_ref);
      if (!pending.length || (!active.has(chat.chat_ref) && pending.every((p) => this.views.has(key(p.chat_ref, p.message_id))))) continue;
      try {
        await this.prepare(chat, pending, lookups);
      } catch (err) {
        errors.push(`${chat.title} (context): ${String((err as Error).message).slice(0, 200)}`);
      }
    }
    const keep = new Set(this.state.pending.map((p) => key(p.chat_ref, p.message_id)));
    for (const k of this.views.keys()) if (!keep.has(k)) this.views.delete(k);
    this.lastRefresh = { at: this.now(), errors };
  }

  /** New messages since the chat's cursor, oldest first. A chat seen for the first time starts lookbackHours back. */
  private async newMessages(chat: Chat): Promise<Message[]> {
    const cs = this.state.chats[chat.chat_ref];
    if (!cs) {
      const recent = asList<Message>(await this.upstream("read_chat_history", { chat_ref: chat.chat_ref, limit: 50 })).sort(byId);
      const since = this.now() - this.lookbackHours * 3_600_000;
      this.state.chats[chat.chat_ref] = {
        cursor: recent.at(-1)?.message_id ?? 0,
        floor: recent[0]?.message_id ?? 0,
        mine: recent.filter((m) => isMine(m, this.me)).map((m) => m.message_id),
      };
      return recent.filter((m) => m.timestamp && Date.parse(m.timestamp) >= since);
    }
    const out: Message[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const msgs = asList<Message>(await this.upstream("get_new_messages", { chat_ref: chat.chat_ref, after_message_id: cs.cursor, limit: PAGE }));
      out.push(...msgs);
      if (msgs.length) cs.cursor = Math.max(cs.cursor, ...msgs.map((m) => m.message_id));
      if (msgs.length < PAGE) break;
    }
    return out.sort(byId);
  }

  private async classify(chat: Chat, msgs: Message[], lookups: { left: number }) {
    const cs = this.state.chats[chat.chat_ref]!;
    const mine = new Set(cs.mine);
    for (const m of msgs) if (isMine(m, this.me)) mine.add(m.message_id);
    for (const m of msgs) {
      const kinds: Kind[] = [];
      if (isMine(m, this.me)) kinds.push("own");
      else {
        if (isDm(chat)) kinds.push("dm");
        if (mentionsMe(m.text, this.me)) kinds.push("mention");
        const to = m.reply_to_message_id;
        if (to && (mine.has(to) || (to < cs.floor && (await this.lookup(chat, to, lookups)).mine))) {
          mine.add(to);
          kinds.push("reply");
        }
      }
      if (kinds.length && !this.state.pending.some((p) => p.chat_ref === chat.chat_ref && p.message_id === m.message_id)) {
        this.state.pending.push({ chat_ref: chat.chat_ref, message_id: m.message_id, kinds, handed_out: 0 });
      }
    }
    cs.mine = [...mine].sort((a, b) => a - b).slice(-MINE_KEEP);
  }

  private async lookup(chat: Chat, id: number, lookups: { left: number }): Promise<{ msg?: Message; mine: boolean }> {
    if (lookups.left <= 0) return { mine: false };
    lookups.left--;
    const [m] = asList<Message>(await this.upstream("read_chat_history", { chat_ref: chat.chat_ref, before_message_id: id + 1, limit: 1 }));
    return m?.message_id === id ? { msg: m, mine: isMine(m, this.me) } : { mine: false };
  }

  /**
   * Gives every candidate in a chat its context with as few reads as possible: one window of
   * messages from just before the oldest unprepared candidate, repeated for any past its end.
   */
  private async prepare(chat: Chat, pending: Pending[], lookups: { left: number }) {
    let todo = [...pending].sort((a, b) => a.message_id - b.message_id);
    let pages = 0;
    while (todo.length && pages < MAX_PAGES) {
      // Message IDs are not contiguous (small groups and DMs share the account's counter),
      // so the messages before come from a history read, not from an ID range.
      const first = todo[0]!.message_id;
      const window = asList<Message>(await this.upstream("read_chat_history", { chat_ref: chat.chat_ref, before_message_id: first, limit: CONTEXT_BEFORE })).sort(byId);
      let complete = false;
      for (let page = 0; page < WINDOW_PAGES && pages < MAX_PAGES; page++, pages++) {
        const after = page ? window.at(-1)!.message_id : first - 1;
        const msgs = asList<Message>(await this.upstream("get_new_messages", { chat_ref: chat.chat_ref, after_message_id: after, limit: PAGE })).sort(byId);
        window.push(...msgs);
        if (msgs.length < PAGE) {
          complete = true;
          break;
        }
      }
      const last = window.at(-1)?.message_id ?? Infinity;
      for (const p of todo) {
        const i = window.findIndex((m) => m.message_id === p.message_id);
        if (i < 0) {
          // Missing inside the window, or in a window that reached the end of the chat: deleted.
          // Past an incomplete window: the next window.
          if (p.message_id < last || complete) this.state.pending = this.state.pending.filter((x) => x !== p);
          continue;
        }
        const msg = window[i]!;
        const to = msg.reply_to_message_id;
        const replyTo = to ? (window.find((m) => m.message_id === to) ?? (await this.lookup(chat, to, lookups)).msg) : undefined;
        this.views.set(key(p.chat_ref, p.message_id), this.view(chat, p, msg, replyTo, window.slice(Math.max(0, i - CONTEXT_BEFORE), i), window.slice(i + 1), complete));
      }
      todo = complete ? [] : todo.filter((p) => p.message_id > last);
    }
  }

  private view(chat: Chat, p: Pending, msg: Message, replyTo: Message | undefined, before: Message[], after: Message[], complete: boolean) {
    const v = (m: Message) => ({ message_id: m.message_id, timestamp: m.timestamp, from: m.display_name, from_user: isMine(m, this.me), reply_to_message_id: m.reply_to_message_id, text: m.text });
    return {
      chat_ref: chat.chat_ref,
      chat_title: chat.title,
      chat_type: chat.type,
      kinds: p.kinds,
      ...v(msg),
      reply_to: replyTo ? v(replyTo) : null,
      context_before: before.map(v),
      after: after.slice(0, AFTER_KEEP).map(v),
      after_truncated: after.length > AFTER_KEEP || !complete,
      user_replied_directly: after.some((m) => isMine(m, this.me) && m.reply_to_message_id === p.message_id),
      user_posted_after: after.some((m) => isMine(m, this.me)),
    };
  }

  /**
   * Candidates ready for the agent. Before the first refresh after a start, waits for it
   * (bounded), so the agent never sees an empty list just because the proxy restarted.
   */
  async candidates(opts: { max: number; waitMs?: number }) {
    if (!this.lastRefresh) {
      const wait = new Promise((r) => setTimeout(r, opts.waitMs ?? 240_000).unref());
      await Promise.race([this.refresh().catch(() => undefined), wait]);
    }
    const ready = this.state.pending.filter((p) => this.views.has(key(p.chat_ref, p.message_id)));
    const waiting = this.state.pending.length - ready.length;
    ready.sort((a, b) => a.chat_ref.localeCompare(b.chat_ref) || a.message_id - b.message_id);
    const batch = ready.slice(0, opts.max);
    const candidates = batch.map((p) => ({ ...this.views.get(key(p.chat_ref, p.message_id))!, message_id: p.message_id }));
    // Handed out one last time on the MAX_HANDOUTS-th call, then forgotten.
    for (const p of batch) p.handed_out++;
    this.state.pending = this.state.pending.filter((p) => p.handed_out < MAX_HANDOUTS);
    this.save();
    return {
      candidates,
      more_ready: ready.length - batch.length,
      waiting_for_context: waiting,
      last_scan_at: this.lastRefresh ? new Date(this.lastRefresh.at).toISOString() : null,
      errors: this.lastRefresh?.errors ?? ["the first scan since the proxy started has not finished yet"],
    };
  }

  /** Remove handled candidates so they are not handed out again. */
  ack(items: { chat_ref: string; message_id: number }[]) {
    const before = this.state.pending.length;
    this.state.pending = this.state.pending.filter((p) => !items.some((i) => i.chat_ref === p.chat_ref && i.message_id === p.message_id));
    for (const i of items) this.views.delete(key(i.chat_ref, i.message_id));
    this.save();
    return { acknowledged: before - this.state.pending.length, still_pending: this.state.pending.length };
  }

  /**
   * What happened in a chat after a message, for closing tasks: whether the user replied to it
   * or posted since. The chat is found by ref, or by title when the ref has changed.
   */
  async followups(items: { chat_ref?: string; chat_title?: string; message_id: number }[]) {
    if (!items.length) return { results: [] };
    const chats = this.chatList.length ? this.chatList : asList<Chat>(await this.upstream("list_allowed_chats", {}));
    const results = [];
    for (const i of items) {
      const chat = chats.find((c) => c.chat_ref === i.chat_ref) ?? chats.find((c) => i.chat_title && c.title.trim().toLowerCase() === i.chat_title.trim().toLowerCase());
      if (!chat) {
        results.push({ ...i, found: false, reason: "chat not on the allowlist (or renamed)" });
        continue;
      }
      try {
        const after = asList<Message>(await this.upstream("get_new_messages", { chat_ref: chat.chat_ref, after_message_id: i.message_id, limit: 50 }));
        const mine = after.filter((m) => isMine(m, this.me));
        results.push({
          ...i,
          found: true,
          chat_ref: chat.chat_ref,
          chat_title: chat.title,
          user_replied_directly: mine.some((m) => m.reply_to_message_id === i.message_id),
          user_messages_after: mine.map((m) => ({ message_id: m.message_id, timestamp: m.timestamp, reply_to_message_id: m.reply_to_message_id, text: m.text })),
          later_messages: after.length,
          later_from_others: after.filter((m) => !isMine(m, this.me)).slice(0, 15).map((m) => ({ message_id: m.message_id, timestamp: m.timestamp, from: m.display_name, reply_to_message_id: m.reply_to_message_id, text: m.text })),
        });
      } catch (err) {
        results.push({ ...i, found: false, reason: String((err as Error).message).slice(0, 200) });
      }
    }
    return { results };
  }
}
