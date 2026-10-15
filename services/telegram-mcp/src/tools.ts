// The MCP tools (D-37): four reads, for the Assistant and the Scout, and the Scout's own tools.
// Fixed functions with validated arguments; none takes a method name, a username or a raw peer,
// and chats outside the scope (excluded, muted, archived) don't exist for any of them.
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type Scout, untrusted } from "./scout.js";
import type { Message, Source } from "./source.js";

const ref = z.object({ chat_ref: z.string().min(1).max(100), message_id: z.number().int().positive() });
const chatRef = z.string().min(1).max(300);

const Mentions = z.object({ max: z.number().int().min(1).max(50).default(30) });
const Ack = z.object({ items: z.array(ref).min(1).max(200) });
const Followups = z.object({
  items: z
    .array(z.object({ chat_ref: z.string().max(100).optional(), chat_title: z.string().max(300).optional(), message_id: z.number().int().positive() }))
    .max(50),
});
const List = z.object({}).strict();
const History = z.object({ chat_ref: chatRef, before_message_id: z.number().int().positive().optional(), limit: z.number().int().min(1).max(50).default(20) });
const NewMessages = z.object({ chat_ref: chatRef, after_message_id: z.number().int().min(0), limit: z.number().int().min(1).max(100).default(50) });
const Search = z.object({ query: z.string().min(1).max(200), chat_ref: chatRef.optional(), limit: z.number().int().min(1).max(50).default(20) });

const annotations = (readOnly: boolean) => ({ readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false });
const obj = (properties: Record<string, object>, required: string[] = []) => ({ type: "object" as const, properties, required, additionalProperties: false });
const CHAT_REF = { type: "string", description: "A chat_ref from list_allowed_chats (tg:…). An exact chat title also works." };

export const READ_TOOLS: Tool[] = [
  {
    name: "list_allowed_chats",
    description: "The user's Telegram chats Pennyworth can read: DMs, groups and channels in the main list (muted, archived and excluded chats are left out). chat_refs are stable.",
    inputSchema: obj({}),
    annotations: annotations(true),
  },
  {
    name: "read_chat_history",
    description: "Messages in a chat, newest first: the latest ones, or those before before_message_id. Message IDs are not contiguous, so read 'the messages before' with this tool rather than by ID range.",
    inputSchema: obj({ chat_ref: CHAT_REF, before_message_id: { type: "integer" }, limit: { type: "integer", minimum: 1, maximum: 50, default: 20 } }, ["chat_ref"]),
    annotations: annotations(true),
  },
  {
    name: "get_new_messages",
    description: "Messages in a chat after after_message_id, oldest first (the ones right after it).",
    inputSchema: obj({ chat_ref: CHAT_REF, after_message_id: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100, default: 50 } }, ["chat_ref", "after_message_id"]),
    annotations: annotations(true),
  },
  {
    name: "search_chat_history",
    description: "Text search in one chat, or across all the user's chats when chat_ref is left out. Newest first.",
    inputSchema: obj({ query: { type: "string" }, chat_ref: CHAT_REF, limit: { type: "integer", minimum: 1, maximum: 50, default: 20 } }, ["query"]),
    annotations: annotations(true),
  },
];

export const SCOUT_TOOLS: Tool[] = [
  {
    name: "telegram_mentions",
    description:
      "Messages that may need the user: mentions (by @handle, name link or name), replies to the user's messages, DMs, and the user's own messages (kind \"own\", for commitments). " +
      "Each comes with context, the message it replies to, and what came after (including whether the user already replied). " +
      "New messages are picked up as they arrive (last_scan_at is the last full sweep). Candidates come back on every call until acknowledged with telegram_mentions_ack (at most 3 times).",
    inputSchema: obj({ max: { type: "integer", minimum: 1, maximum: 50, default: 30, description: "Candidates returned per call; more_ready says how many remain." } }),
    annotations: annotations(false),
  },
  {
    name: "telegram_mentions_ack",
    description: "Mark candidates from telegram_mentions as handled (task created, or decided no task), so they are not returned again. Only changes Pennyworth's local state.",
    inputSchema: obj(
      {
        items: {
          type: "array",
          items: obj({ chat_ref: { type: "string" }, message_id: { type: "integer" } }, ["chat_ref", "message_id"]),
        },
      },
      ["items"],
    ),
    annotations: annotations(false),
  },
  {
    name: "telegram_followups",
    description:
      "For messages behind open tasks: whether the user has replied to the message or posted in the chat since, and what others said after it. " +
      "Give chat_ref and also chat_title: tasks made before the switch to stable refs are found by title.",
    inputSchema: obj(
      {
        items: {
          type: "array",
          items: obj({ chat_ref: { type: "string" }, chat_title: { type: "string" }, message_id: { type: "integer" } }, ["message_id"]),
        },
      },
      ["items"],
    ),
    annotations: annotations(true),
  },
];

export const TOOLS = [...READ_TOOLS, ...SCOUT_TOOLS];
export const isTool = (name: string) => TOOLS.some((t) => t.name === name);

export class ToolError extends Error {}

const out = (m: Message) => ({
  chat_ref: m.chat_ref,
  message_id: m.message_id,
  timestamp: m.timestamp,
  from: m.display_name,
  from_username: m.username,
  from_user: m.out,
  reply_to_message_id: m.reply_to_message_id,
  topic_id: m.topic_id,
  text: untrusted(m.text),
});

export async function callTool(scout: Scout, source: Source, name: string, args: unknown): Promise<unknown> {
  const chat = (r: string) => {
    const c = scout.findChat(r, r);
    if (!c) throw new ToolError(`chat ${r} not found: use a chat_ref from list_allowed_chats`);
    return c;
  };
  switch (name) {
    case "list_allowed_chats":
      List.parse(args ?? {});
      return { chats: scout.chats().map((c) => ({ chat_ref: c.chat_ref, title: c.title, type: c.type, unread_mentions: c.unread_mentions })) };
    case "read_chat_history": {
      const a = History.parse(args);
      return { messages: (await source.before(chat(a.chat_ref).chat_ref, a.before_message_id, a.limit)).reverse().map(out) };
    }
    case "get_new_messages": {
      const a = NewMessages.parse(args);
      return { messages: (await source.after(chat(a.chat_ref).chat_ref, a.after_message_id, a.limit)).map(out) };
    }
    case "search_chat_history": {
      const a = Search.parse(args);
      const found = await source.search(a.query, a.chat_ref ? chat(a.chat_ref).chat_ref : undefined, a.limit);
      // A global search covers every chat; only those in scope come back.
      return { messages: found.filter((m) => scout.findChat(m.chat_ref)).map((m) => ({ ...out(m), chat_title: scout.findChat(m.chat_ref)!.title })) };
    }
    case "telegram_mentions":
      return scout.candidates({ max: Mentions.parse(args ?? {}).max });
    case "telegram_mentions_ack":
      return scout.ack(Ack.parse(args).items);
    case "telegram_followups":
      return scout.followups(Followups.parse(args).items);
    default:
      throw new ToolError(`unknown tool ${name}`);
  }
}
