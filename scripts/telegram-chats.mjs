#!/usr/bin/env node
// Print a link to the Telegram MCP server's chat picker, to change which chats Pennyworth reads.
// The link is short-lived and opens only after Okta sign-in as you; nothing changes until you save.
// The proxy never exposes this tool to agents (D-27), so it is fetched here with the stored token.
// Never refreshes the token: the proxy owns the (rotating) refresh token. If the access token has
// expired, the proxy renews it on its next scan (every 15 minutes); run this again then.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const env = Object.fromEntries(
  readFileSync(join(root, process.env.PENNYWORTH_ENV_FILE ?? ".env"), "utf8")
    .split("\n")
    .map((l) => /^\s*([A-Z0-9_]+)=(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim().replace(/^["']|["']$/g, "")]),
);
const url = env.TELEGRAM_MCP_URL;
if (!url) throw new Error("set TELEGRAM_MCP_URL in .env");
const secrets = (env.PENNYWORTH_SECRETS_DIR ?? "~/.config/pennyworth").replace(/^~/, process.env.HOME);
const tokenPath = join(secrets, "telegram", "token.json");
if (!existsSync(tokenPath)) throw new Error("Telegram is not connected yet: run scripts/telegram-auth.sh");
const token = JSON.parse(readFileSync(tokenPath, "utf8"));
if (token.expires_at && token.expires_at - 60_000 < Date.now()) {
  console.error("The Telegram access token has just expired; the proxy renews it on its next scan. Try again in 15 minutes.");
  process.exit(1);
}

let session;
async function rpc(id, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token.access_token}`,
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params }),
  });
  session ??= res.headers.get("mcp-session-id") ?? undefined;
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  if (!id) return undefined;
  const text = await res.text();
  const body = text.startsWith("{") ? text : text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop();
  const msg = JSON.parse(body ?? "{}");
  if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
  return msg.result;
}

await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pennyworth-chat-picker", version: "1" } });
await rpc(undefined, "notifications/initialized", {});
const result = await rpc(2, "tools/call", { name: "request_allowed_chats_change", arguments: {} });
const structured = result?.structuredContent ?? JSON.parse(result?.content?.find((c) => c.type === "text")?.text ?? "{}");
const link = structured.manage_url ?? structured.result?.manage_url;
if (!link) throw new Error("the server did not return a manage_url");
console.log(`Open this link (short-lived), sign in, pick the chats and save:\n\n  ${link}\n`);
console.log("Pennyworth picks up the new list on its next Telegram scan (within 15 minutes).");
