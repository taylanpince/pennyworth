// Pennyworth's own tools on top of the upstream read tools: the scout's scan, its
// acknowledgement, and the follow-up check used to close answered tasks.
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Scout } from "./scout.js";

const ref = z.object({ chat_ref: z.string().min(1), message_id: z.number().int().positive() });

const Mentions = z.object({ max: z.number().int().min(1).max(50).default(30) });
const Ack = z.object({ items: z.array(ref).min(1).max(200) });
const Followups = z.object({
  items: z
    .array(z.object({ chat_ref: z.string().optional(), chat_title: z.string().optional(), message_id: z.number().int().positive() }))
    .max(50),
});

const local = (readOnly: boolean) => ({ readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false });

export const LOCAL_TOOLS: Tool[] = [
  {
    name: "telegram_mentions",
    description:
      "Messages in the allowed chats that may need the user: mentions by @handle or name, replies to the user's messages, DMs, and the user's own messages (kind \"own\", for commitments). " +
      "Each comes with context, the message it replies to, and what came after (including whether the user already replied). " +
      "The chats are scanned in the background every few minutes (last_scan_at). Candidates come back on every call until acknowledged with telegram_mentions_ack (at most 3 times).",
    inputSchema: {
      type: "object",
      properties: {
        max: { type: "integer", minimum: 1, maximum: 50, default: 30, description: "Candidates returned per call; more_ready says how many remain." },
      },
      additionalProperties: false,
    },
    annotations: local(false),
  },
  {
    name: "telegram_mentions_ack",
    description: "Mark candidates from telegram_mentions as handled (task created, or decided no task), so they are not returned again. Only changes Pennyworth's local state.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object", properties: { chat_ref: { type: "string" }, message_id: { type: "integer" } }, required: ["chat_ref", "message_id"], additionalProperties: false },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    annotations: local(false),
  },
  {
    name: "telegram_followups",
    description:
      "For messages behind open tasks: whether the user has replied to the message or posted in the chat since, and what others said after it. " +
      "Give chat_ref and also chat_title: refs change when the user edits the allowlist, and the chat is then found by title.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { chat_ref: { type: "string" }, chat_title: { type: "string" }, message_id: { type: "integer" } },
            required: ["message_id"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    annotations: local(true),
  },
];

export const isLocalTool = (name: string) => LOCAL_TOOLS.some((t) => t.name === name);

export async function callLocalTool(scout: Scout, name: string, args: unknown): Promise<unknown> {
  switch (name) {
    case "telegram_mentions": {
      return scout.candidates({ max: Mentions.parse(args ?? {}).max });
    }
    case "telegram_mentions_ack":
      return scout.ack(Ack.parse(args).items);
    case "telegram_followups":
      return scout.followups(Followups.parse(args).items);
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
