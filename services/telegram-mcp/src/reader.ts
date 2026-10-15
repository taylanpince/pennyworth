// GramJS behind the Source interface: the user's own Telegram session (D-37), read-only through
// guard.ts. Nothing here keeps message text beyond the call that returned it.
import type bigInt from "big-integer";
import { Api, TelegramClient, utils } from "telegram";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import { LogLevel } from "telegram/extensions/Logger.js";
import { StringSession } from "telegram/sessions/index.js";
import { guard, readAllowed } from "./guard.js";
import type { Account, Chat, Message, Source } from "./source.js";

export interface ApiCredentials {
  api_id: number;
  api_hash: string;
}

/** How the session appears under Telegram → Settings → Devices. */
export const DEVICE = { deviceModel: process.env.TELEGRAM_DEVICE_NAME ?? "Pennyworth", appVersion: "Pennyworth 1.0", systemVersion: "Linux" };

/** A GramJS client with the given request check and quiet logging. */
export function newClient(session: string, api: ApiCredentials, allowed: (className: string) => boolean, onRefused?: (className: string) => void): TelegramClient {
  const client = new TelegramClient(new StringSession(session), api.api_id, api.api_hash, {
    ...DEVICE,
    connectionRetries: 5,
    autoReconnect: true,
    floodSleepThreshold: 60,
    langCode: "en",
    systemLangCode: "en",
  });
  // GramJS logs at info by default, request by request.
  client.setLogLevel(LogLevel.ERROR);
  return guard(client, allowed, onRefused);
}

export const refOf = (peer: Api.TypePeer | bigInt.BigInteger | string) => `tg:${utils.getPeerId(peer as never)}`;

const MEDIA: [new (...a: never[]) => unknown, string][] = [
  [Api.MessageMediaPhoto, "photo"],
  [Api.MessageMediaDocument, "file"],
  [Api.MessageMediaGeo, "location"],
  [Api.MessageMediaContact, "contact"],
  [Api.MessageMediaPoll, "poll"],
  [Api.MessageMediaWebPage, ""],
];

function nameOf(entity: unknown): { name: string | null; username: string | null; bot: boolean } {
  if (entity instanceof Api.User) {
    const name = [entity.firstName, entity.lastName].filter(Boolean).join(" ").trim();
    return { name: name || (entity.deleted ? "Deleted account" : null), username: entity.username ?? entity.usernames?.[0]?.username ?? null, bot: Boolean(entity.bot) };
  }
  if (entity instanceof Api.Channel || entity instanceof Api.Chat) return { name: entity.title, username: entity instanceof Api.Channel ? (entity.username ?? null) : null, bot: false };
  return { name: null, username: null, bot: false };
}

/** Our message shape, or undefined for service and empty messages. */
export function toMessage(m: Api.TypeMessage | undefined): Message | undefined {
  if (!(m instanceof Api.Message)) return undefined;
  const media = MEDIA.find(([cls]) => m.media instanceof cls);
  let text = m.message ?? "";
  if (media && media[1]) {
    const file = m.media instanceof Api.MessageMediaDocument && m.media.document instanceof Api.Document ? m.media.document.attributes.find((a) => a instanceof Api.DocumentAttributeFilename) : undefined;
    const label = file instanceof Api.DocumentAttributeFilename ? `file: ${file.fileName}` : media[1];
    text = text ? `${text}\n[${label}]` : `[${label}]`;
  }
  const r = m.replyTo instanceof Api.MessageReplyHeader ? m.replyTo : undefined;
  // In a forum, a message that starts no reply still points at its topic's first message.
  const topic = r?.forumTopic ? (r.replyToTopId ?? r.replyToMsgId ?? null) : null;
  const replyTo = r?.forumTopic && !r.replyToTopId ? null : (r?.replyToMsgId ?? null);
  const sender = nameOf(m.sender);
  return {
    chat_ref: refOf(m.peerId),
    message_id: m.id,
    timestamp: m.date ? new Date(m.date * 1000).toISOString() : null,
    text,
    reply_to_message_id: replyTo,
    topic_id: topic,
    sender_id: m.senderId ? m.senderId.toString() : null,
    display_name: sender.name,
    username: sender.username,
    sender_is_bot: sender.bot,
    out: Boolean(m.out),
    mentioned: Boolean(m.mentioned),
  };
}

export class TelegramReader implements Source {
  private account?: Account;
  private peers = new Map<string, Api.TypeInputPeer>();

  constructor(readonly client: TelegramClient) {}

  async start(): Promise<Account> {
    await this.client.connect();
    const me = await this.client.getMe();
    this.account = { id: me.id.toString(), username: me.username ?? me.usernames?.[0]?.username ?? null, name: nameOf(me).name ?? "" };
    // Ask for updates: Telegram pushes new messages only to a client that has asked once.
    await this.client.invoke(new Api.updates.GetState());
    return this.account;
  }

  me(): Account {
    if (!this.account) throw new Error("Telegram is not connected yet");
    return this.account;
  }

  async dialogs({ archived }: { archived: boolean }): Promise<Chat[]> {
    const now = Date.now() / 1000;
    const out: Chat[] = [];
    for (const folder of archived ? [false, true] : [false]) {
      for (const d of await this.client.getDialogs({ archived: folder })) {
        const e = d.entity;
        const dialog = d.dialog instanceof Api.Dialog ? d.dialog : undefined;
        if (!e || !dialog) continue;
        let type: Chat["type"];
        if (e instanceof Api.User) {
          if (e.bot || e.self) continue;
          type = "dm";
        } else if (e instanceof Api.Chat) {
          if (e.migratedTo || e.deactivated || e.left) continue;
          type = "group";
        } else if (e instanceof Api.Channel) {
          if (e.left) continue;
          type = e.broadcast && !e.gigagroup ? "channel" : "group";
        } else continue;
        const ref = refOf(dialog.peer);
        this.peers.set(ref, utils.getInputPeer(e));
        const muteUntil = dialog.notifySettings instanceof Api.PeerNotifySettings ? (dialog.notifySettings.muteUntil ?? 0) : 0;
        out.push({
          chat_ref: ref,
          title: (d.title ?? nameOf(e).name ?? "").trim() || ref,
          type,
          top_message: dialog.topMessage,
          muted: muteUntil > now,
          archived: folder,
          unread_mentions: dialog.unreadMentionsCount ?? 0,
        });
      }
    }
    return out;
  }

  private peer(chat_ref: string): Api.TypeInputPeer {
    const p = this.peers.get(chat_ref);
    if (!p) throw new Error(`unknown chat ${chat_ref}`);
    return p;
  }

  private list(msgs: Api.TypeMessage[] | Iterable<Api.TypeMessage | undefined>): Message[] {
    const out: Message[] = [];
    for (const m of msgs) {
      const x = toMessage(m);
      if (x) out.push(x);
    }
    return out;
  }

  async before(chat_ref: string, before: number | undefined, limit: number): Promise<Message[]> {
    const msgs = await this.client.getMessages(this.peer(chat_ref), { limit, offsetId: before ?? 0 });
    return this.list(msgs).reverse();
  }

  async after(chat_ref: string, after: number, limit: number): Promise<Message[]> {
    const msgs = await this.client.getMessages(this.peer(chat_ref), { limit, minId: after, reverse: true });
    return this.list(msgs).filter((m) => m.message_id > after);
  }

  async byIds(chat_ref: string, ids: number[]): Promise<Message[]> {
    if (!ids.length) return [];
    return this.list(await this.client.getMessages(this.peer(chat_ref), { ids }));
  }

  async search(query: string, chat_ref: string | undefined, limit: number): Promise<Message[]> {
    return this.list(await this.client.getMessages(chat_ref ? this.peer(chat_ref) : undefined, { search: query, limit }));
  }

  async topics(chat_ref: string, ids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const peer = this.peer(chat_ref);
    if (!ids.length || !(peer instanceof Api.InputPeerChannel)) return out;
    const r = await this.client.invoke(new Api.channels.GetForumTopicsByID({ channel: new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash }), topics: ids }));
    for (const t of r.topics) if (t instanceof Api.ForumTopic) out.set(t.id, t.title);
    return out;
  }

  onMessage(handler: (m: Message) => void): void {
    this.client.addEventHandler((e: NewMessageEvent) => {
      const m = toMessage(e.message);
      if (m) handler(m);
    }, new NewMessage({}));
  }

  async stop(): Promise<void> {
    await this.client.destroy().catch(() => undefined);
  }
}

export const readingClient = (session: string, api: ApiCredentials, onRefused?: (className: string) => void) => newClient(session, api, readAllowed, onRefused);
