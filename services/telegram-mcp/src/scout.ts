// Deterministic part of the Telegram Scout (D-37): picks the messages that may need the user
// (mentions, replies to the user's messages, DMs, and the user's own messages for commitments) as
// they arrive, and catches up from per-chat cursors with a sweep of the dialog list. The agent only
// judges. The state file holds cursors and message IDs only; message text is read when asked for.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Chat, Message, Source } from "./source.js";

export type Kind = "mention" | "reply" | "dm" | "own";

export interface Scope {
  /** Chat refs (`tg:…`) or exact titles never scanned or read. */
  exclude: string[];
  include_muted: boolean;
  include_archived: boolean;
}

interface ChatState {
  cursor: number; // highest message ID handled
  mine: number[]; // the user's message IDs seen (bounded)
}

interface Pending {
  chat_ref: string;
  message_id: number;
  kinds: Kind[];
  handed_out: number;
}

export interface State {
  version: 2;
  chats: Record<string, ChatState>;
  pending: Pending[];
}

const MINE_KEEP = 500;
const MAX_HANDOUTS = 3; // a candidate the agent never acknowledges is dropped after this many runs
const PAGE = 100;
const MAX_PAGES = 10; // per chat per catch-up
const CONTEXT_BEFORE = 5;
const AFTER_KEEP = 30;
const NEW_CHAT_MESSAGES = 50; // a chat that appears while running: its recent messages are scanned
const PARALLEL_CHATS = 4;

/**
 * The state file. A version 1 file (the organization's MCP, D-27) has refs that no longer exist, so
 * it is dropped, and the first sweep starts every chat at its current top message (no backfill).
 */
export function loadState(path: string): { state: State; fresh: boolean; migrated: boolean } {
  if (!existsSync(path)) return { state: { version: 2, chats: {}, pending: [] }, fresh: true, migrated: false };
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<State>;
  if (raw.version !== 2) return { state: { version: 2, chats: {}, pending: [] }, fresh: false, migrated: true };
  return { state: { version: 2, chats: raw.chats ?? {}, pending: raw.pending ?? [] }, fresh: false, migrated: false };
}

export function saveState(path: string, state: State): void {
  const tmp = join(dirname(path), `.scout.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Plain-text mentions by name ("taylan, can you…"), which Telegram doesn't flag. Whole words, case-insensitive. */
export function mentionsAlias(text: string, aliases: string[]): boolean {
  const parts = aliases.filter(Boolean).map((a) => `(?<![\\p{L}\\p{N}_@])${escape(a)}(?![\\p{L}\\p{N}_])`);
  return parts.length > 0 && new RegExp(parts.join("|"), "iu").test(text);
}

/** Chats any tool may see: not excluded, and not muted or archived unless the scope says so. */
export function inScope(chat: Chat, scope: Scope): boolean {
  const title = chat.title.trim().toLowerCase();
  if (scope.exclude.some((x) => x === chat.chat_ref || x.trim().toLowerCase() === title)) return false;
  if (chat.muted && !scope.include_muted) return false;
  if (chat.archived && !scope.include_archived) return false;
  return true;
}

/** Chats the scan reads: broadcast channels can be read on request, but nobody mentions you there. */
export const scanned = (chat: Chat) => chat.type !== "channel";

/** Message text for agents: untrusted, and unable to close its own wrapper. */
export const untrusted = (text: string) => `<untrusted-telegram-content>${text.replace(/untrusted-telegram-content/gi, "untrusted_telegram_content")}</untrusted-telegram-content>`;

const key = (chat_ref: string, message_id: number) => `${chat_ref}:${message_id}`;
const byId = (a: Message, b: Message) => a.message_id - b.message_id;
const norm = (s: string) => s.trim().toLowerCase();

export interface ScoutOptions {
  aliases: string[];
  scope: Scope;
  statePath: string;
  /** How far back a fresh install looks on its first sweep. */
  lookbackHours?: number;
  now?: () => number;
  saveDelayMs?: number;
}

export class Scout {
  private state: State;
  private fresh: boolean;
  private chatMap = new Map<string, Chat>(); // in scope
  private known = new Set<string>(); // every dialog seen in the last sweep, in scope or not
  private swept = false;
  private queue: Promise<unknown> = Promise.resolve();
  private lastSweep?: { at: number; errors: string[] };
  private saveTimer?: NodeJS.Timeout;
  private topicTitles = new Map<string, string>();
  private readonly now: () => number;

  constructor(
    private readonly source: Source,
    private readonly opts: ScoutOptions,
  ) {
    const loaded = loadState(opts.statePath);
    this.state = loaded.state;
    this.fresh = loaded.fresh;
    this.now = opts.now ?? Date.now;
  }

  /** Runs `fn` after everything queued before it: events and sweeps never interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private save(now = false) {
    if (now || !this.opts.saveDelayMs) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      saveState(this.opts.statePath, this.state);
      return;
    }
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = undefined;
      saveState(this.opts.statePath, this.state);
    }, this.opts.saveDelayMs).unref();
  }

  flush() {
    if (this.saveTimer) this.save(true);
  }

  /** In-scope chats, as of the last sweep. */
  chats(): Chat[] {
    return [...this.chatMap.values()];
  }

  /** A chat in scope by ref, or by title when the ref is unknown (old tasks, renamed groups). */
  findChat(chat_ref?: string, title?: string): Chat | undefined {
    if (chat_ref && this.chatMap.has(chat_ref)) return this.chatMap.get(chat_ref);
    if (!title) return undefined;
    const t = norm(title);
    return this.chats().find((c) => norm(c.title) === t);
  }

  status() {
    return { last_scan_at: this.lastSweep ? new Date(this.lastSweep.at).toISOString() : null, errors: this.lastSweep?.errors ?? [] };
  }

  /** Reloads the dialog list and catches every scanned chat up from its cursor. */
  sweep(): Promise<void> {
    return this.serial(() => this.doSweep());
  }

  /** A new message pushed by Telegram. */
  handle(m: Message): Promise<void> {
    return this.serial(async () => {
      let chat = this.chatMap.get(m.chat_ref);
      if (!chat && !this.known.has(m.chat_ref)) {
        // A chat that didn't exist at the last sweep (a new DM, a new group): load it now.
        await this.loadDialogs();
        chat = this.chatMap.get(m.chat_ref);
        if (chat && scanned(chat) && !this.state.chats[chat.chat_ref]) this.state.chats[chat.chat_ref] = { cursor: m.message_id - 1, mine: [] };
      }
      if (!chat || !scanned(chat)) return;
      const cs = this.state.chats[chat.chat_ref];
      if (!cs) return; // came into scope since the last sweep; the next sweep starts it
      if (m.message_id <= cs.cursor) return;
      await this.classify(chat, [m]);
      this.save();
    });
  }

  private async loadDialogs(): Promise<Chat[]> {
    const all = await this.source.dialogs({ archived: this.opts.scope.include_archived });
    this.known = new Set(all.map((c) => c.chat_ref));
    this.chatMap = new Map(all.filter((c) => inScope(c, this.opts.scope)).map((c) => [c.chat_ref, c]));
    return all;
  }

  private async doSweep(): Promise<void> {
    const errors: string[] = [];
    const before = new Set(this.known);
    const first = !this.swept;
    await this.loadDialogs();
    // Chats that left the scope (muted, archived, excluded, left) are forgotten; coming back starts at the top.
    for (const ref of Object.keys(this.state.chats)) {
      const c = this.chatMap.get(ref);
      if (!c || !scanned(c)) delete this.state.chats[ref];
    }
    this.state.pending = this.state.pending.filter((p) => this.chatMap.has(p.chat_ref));

    const work: (() => Promise<void>)[] = [];
    const titles: string[] = [];
    for (const chat of this.chats().filter(scanned)) {
      const cs = this.state.chats[chat.chat_ref];
      if (!cs) {
        // A fresh install looks back; a chat that appeared since the last sweep (a new DM) is read
        // from its recent messages; anything else (the switch from D-27, unmuted) starts at the top.
        if (first && this.fresh && (this.opts.lookbackHours ?? 0) > 0) work.push(() => this.startRecent(chat, (this.opts.lookbackHours ?? 0) * 3_600_000));
        else if (!first && !before.has(chat.chat_ref)) work.push(() => this.startRecent(chat, 24 * 3_600_000));
        else {
          this.state.chats[chat.chat_ref] = { cursor: chat.top_message, mine: [] };
          continue;
        }
      } else if (chat.top_message > cs.cursor) work.push(() => this.catchUp(chat));
      else continue;
      titles[work.length - 1] = chat.title;
    }
    await pool(work, PARALLEL_CHATS, (err, i) => errors.push(`${titles[i] ?? i}: ${String((err as Error).message).slice(0, 200)}`));
    this.swept = true;
    this.fresh = false;
    this.save(true);
    this.lastSweep = { at: this.now(), errors };
  }

  /** A chat seen for the first time: its recent messages, then live. */
  private async startRecent(chat: Chat, windowMs: number) {
    const recent = await this.source.before(chat.chat_ref, undefined, NEW_CHAT_MESSAGES);
    const since = this.now() - windowMs;
    this.state.chats[chat.chat_ref] = { cursor: 0, mine: recent.filter((m) => m.out).map((m) => m.message_id) };
    await this.classify(
      chat,
      recent.filter((m) => m.timestamp && Date.parse(m.timestamp) >= since),
    );
    const cs = this.state.chats[chat.chat_ref]!;
    cs.cursor = Math.max(cs.cursor, chat.top_message, ...recent.map((m) => m.message_id));
  }

  private async catchUp(chat: Chat) {
    const cs = this.state.chats[chat.chat_ref]!;
    for (let page = 0; page < MAX_PAGES; page++) {
      const msgs = await this.source.after(chat.chat_ref, cs.cursor, PAGE);
      await this.classify(chat, msgs);
      if (msgs.length < PAGE) return;
    }
    // Too far behind: skip ahead rather than spend the sweep on one chat.
    cs.cursor = Math.max(cs.cursor, chat.top_message);
  }

  /** Adds candidates for new messages and advances the chat's cursor past them. */
  private async classify(chat: Chat, msgs: Message[]) {
    const cs = this.state.chats[chat.chat_ref]!;
    const mine = new Set(cs.mine);
    const fresh = msgs.filter((m) => m.message_id > cs.cursor).sort(byId);
    for (const m of fresh) if (m.out) mine.add(m.message_id);
    for (const m of fresh) {
      const kinds: Kind[] = [];
      if (m.out) kinds.push("own");
      else if (!m.sender_is_bot) {
        if (chat.type === "dm") kinds.push("dm");
        // Telegram flags both mentions and replies to the user's messages; the replied-to message tells them apart.
        let replyToMine = false;
        const to = m.reply_to_message_id;
        if (m.mentioned && to) {
          if (mine.has(to)) replyToMine = true;
          else {
            const [target] = await this.source.byIds(chat.chat_ref, [to]).catch(() => [] as Message[]);
            replyToMine = Boolean(target?.out);
            if (replyToMine) mine.add(to);
          }
        }
        if (replyToMine) kinds.push("reply");
        if ((m.mentioned && !replyToMine) || mentionsAlias(m.text, this.opts.aliases)) kinds.push("mention");
      }
      if (kinds.length && !this.state.pending.some((p) => p.chat_ref === chat.chat_ref && p.message_id === m.message_id)) {
        this.state.pending.push({ chat_ref: chat.chat_ref, message_id: m.message_id, kinds, handed_out: 0 });
      }
      cs.cursor = Math.max(cs.cursor, m.message_id);
    }
    cs.mine = [...mine].sort((a, b) => a - b).slice(-MINE_KEEP);
  }

  private async topicTitle(chat: Chat, topic: number | null): Promise<string | null> {
    if (!topic) return null;
    const k = key(chat.chat_ref, topic);
    if (!this.topicTitles.has(k)) {
      const titles = await this.source.topics(chat.chat_ref, [topic]).catch(() => new Map<number, string>());
      this.topicTitles.set(k, titles.get(topic) ?? "");
    }
    return this.topicTitles.get(k) || null;
  }

  private viewOf = (m: Message) => ({
    message_id: m.message_id,
    timestamp: m.timestamp,
    from: m.display_name,
    from_username: m.username,
    from_user: m.out,
    reply_to_message_id: m.reply_to_message_id,
    text: untrusted(m.text),
  });

  /** A candidate with its context, read now: the messages before, the one it replies to, and what came after. */
  private async view(chat: Chat, p: Pending) {
    const [msg] = await this.source.byIds(chat.chat_ref, [p.message_id]);
    if (!msg) return undefined; // deleted
    const before = await this.source.before(chat.chat_ref, p.message_id, CONTEXT_BEFORE);
    const after = await this.source.after(chat.chat_ref, p.message_id, AFTER_KEEP + 1);
    const to = msg.reply_to_message_id;
    const replyTo = to ? (before.find((m) => m.message_id === to) ?? (await this.source.byIds(chat.chat_ref, [to]))[0]) : undefined;
    return {
      chat_ref: chat.chat_ref,
      chat_title: chat.title,
      chat_type: chat.type,
      topic: await this.topicTitle(chat, msg.topic_id),
      kinds: p.kinds,
      ...this.viewOf(msg),
      reply_to: replyTo ? this.viewOf(replyTo) : null,
      context_before: before.map(this.viewOf),
      after: after.slice(0, AFTER_KEEP).map(this.viewOf),
      after_truncated: after.length > AFTER_KEEP,
      user_replied_directly: after.some((m) => m.out && m.reply_to_message_id === p.message_id),
      user_posted_after: after.some((m) => m.out),
    };
  }

  /** Candidates with their context, oldest chat-first. Each comes back until acknowledged, at most MAX_HANDOUTS times. */
  async candidates(opts: { max: number }) {
    if (!this.swept) await this.sweep().catch(() => undefined);
    const all = [...this.state.pending].sort((a, b) => a.chat_ref.localeCompare(b.chat_ref) || a.message_id - b.message_id);
    const batch = all.slice(0, opts.max);
    const errors = [...(this.lastSweep?.errors ?? (this.swept ? [] : ["the first scan since the service started has not finished yet"]))];
    const views = new Map<string, Awaited<ReturnType<Scout["view"]>>>();
    const gone = new Set<Pending>();
    const byChat = new Map<string, Pending[]>();
    for (const p of batch) byChat.set(p.chat_ref, [...(byChat.get(p.chat_ref) ?? []), p]);
    await pool(
      [...byChat].map(([ref, ps]) => async () => {
        const chat = this.chatMap.get(ref);
        for (const p of ps) {
          if (!chat) {
            gone.add(p);
            continue;
          }
          const v = await this.view(chat, p);
          if (v) views.set(key(ref, p.message_id), v);
          else gone.add(p);
        }
      }),
      PARALLEL_CHATS,
      (err) => errors.push(`context: ${String((err as Error).message).slice(0, 200)}`),
    );
    const candidates = batch.flatMap((p) => {
      const v = views.get(key(p.chat_ref, p.message_id));
      return v ? [v] : [];
    });
    // Handed out one last time on the MAX_HANDOUTS-th call, then forgotten. Deleted messages go at once.
    for (const p of batch) if (views.has(key(p.chat_ref, p.message_id))) p.handed_out++;
    this.state.pending = this.state.pending.filter((p) => !gone.has(p) && p.handed_out < MAX_HANDOUTS);
    this.save(true);
    return { candidates, more_ready: all.length - batch.length, ...this.status(), errors };
  }

  /** Remove handled candidates so they are not handed out again. */
  ack(items: { chat_ref: string; message_id: number }[]) {
    const before = this.state.pending.length;
    this.state.pending = this.state.pending.filter((p) => !items.some((i) => i.chat_ref === p.chat_ref && i.message_id === p.message_id));
    this.save(true);
    return { acknowledged: before - this.state.pending.length, still_pending: this.state.pending.length };
  }

  /**
   * What happened in a chat after a message, for closing tasks: whether the user replied to it or
   * posted since. The chat is found by ref, or by title (tasks made before D-37 carry old refs).
   */
  async followups(items: { chat_ref?: string; chat_title?: string; message_id: number }[]) {
    if (!this.swept) await this.sweep().catch(() => undefined);
    const results = [];
    for (const i of items) {
      const chat = this.findChat(i.chat_ref, i.chat_title);
      if (!chat) {
        results.push({ ...i, found: false, reason: "chat not found (left, renamed, muted, archived or excluded)" });
        continue;
      }
      try {
        const after = await this.source.after(chat.chat_ref, i.message_id, 50);
        const mine = after.filter((m) => m.out);
        results.push({
          ...i,
          found: true,
          chat_ref: chat.chat_ref,
          chat_title: chat.title,
          user_replied_directly: mine.some((m) => m.reply_to_message_id === i.message_id),
          user_messages_after: mine.map((m) => ({ message_id: m.message_id, timestamp: m.timestamp, reply_to_message_id: m.reply_to_message_id, text: untrusted(m.text) })),
          later_messages: after.length,
          later_from_others: after
            .filter((m) => !m.out)
            .slice(0, 15)
            .map((m) => ({ message_id: m.message_id, timestamp: m.timestamp, from: m.display_name, reply_to_message_id: m.reply_to_message_id, text: untrusted(m.text) })),
        });
      } catch (err) {
        results.push({ ...i, found: false, reason: String((err as Error).message).slice(0, 200) });
      }
    }
    return { results };
  }
}

/** Runs tasks at most `n` at a time; a failing task is reported and the rest carry on. */
async function pool(tasks: (() => Promise<void>)[], n: number, onError: (err: unknown, i: number) => void) {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      await tasks[i]!().catch((err) => onError(err, i));
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
}
