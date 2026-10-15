// What the rest of the service needs from Telegram, independent of GramJS (src/reader.ts), so the
// scout and the tools can be tested against a fake.

export type ChatType = "dm" | "group" | "channel";

export interface Chat {
  /** `tg:<marked peer id>`: users positive, basic groups -id, channels and supergroups -100id. Stable. */
  chat_ref: string;
  title: string;
  /** dm: a person; group: basic group or supergroup (forum topics included); channel: broadcast only. */
  type: ChatType;
  top_message: number;
  muted: boolean;
  archived: boolean;
  /** Unread messages and unread mentions, as the user's own apps show them. */
  unread: number;
  unread_mentions: number;
  /** A basic group upgraded to this supergroup (its old ref), when Telegram says so. */
  migrated_from?: string;
}

export interface Message {
  chat_ref: string;
  message_id: number;
  timestamp: string | null;
  /** Raw text, plus a short marker for media ("[photo]"). Wrapped as untrusted only on output. */
  text: string;
  reply_to_message_id: number | null;
  /** Forum topic the message belongs to (its first message's ID), when the chat has topics. */
  topic_id: number | null;
  sender_id: string | null;
  display_name: string | null;
  username: string | null;
  sender_is_bot: boolean;
  /** Sent by the user's own account. */
  out: boolean;
  /** Telegram's own flag: the message mentions the user or replies to one of their messages. */
  mentioned: boolean;
}

export interface Account {
  id: string;
  username: string | null;
  name: string;
}

export interface Source {
  me(): Account;
  /** The user's dialogs: the main list, plus the archive when asked. Bots and Saved Messages are left out. */
  dialogs(opts: { archived: boolean }): Promise<Chat[]>;
  /** Up to `limit` messages with IDs below `before` (all when undefined), oldest first. */
  before(chat_ref: string, before: number | undefined, limit: number): Promise<Message[]>;
  /** Up to `limit` messages with IDs above `after`, the earliest ones, oldest first. */
  after(chat_ref: string, after: number, limit: number): Promise<Message[]>;
  /** Messages by ID; missing (deleted) ones are left out. */
  byIds(chat_ref: string, ids: number[]): Promise<Message[]>;
  /** Text search in one chat, or across all chats; newest first. */
  search(query: string, chat_ref: string | undefined, limit: number): Promise<Message[]>;
  /** Titles of forum topics by their IDs. */
  topics(chat_ref: string, ids: number[]): Promise<Map<number, string>>;
  /** New messages as they arrive. */
  onMessage(handler: (m: Message) => void): void;
}
