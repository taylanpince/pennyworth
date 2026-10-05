#!/usr/bin/env node
// Call one MCP tool on a streamable-HTTP MCP server (stateless). Dev/diagnostics only.
//   node scripts/dev/mcp-call.mjs <url> <tool> '<json args>' [token]
//   node scripts/dev/mcp-call.mjs <url> --list [token]
const argv = process.argv.slice(2);
const [url, tool] = argv;
const argsJson = tool === "--list" ? "{}" : (argv[2] ?? "{}");
const token = (tool === "--list" ? argv[2] : argv[3]) ?? process.env.MCP_TOKEN ?? "";
if (!url || !tool) {
  console.error("usage: mcp-call.mjs <url> <tool|--list> ['<json args>'] [token]");
  process.exit(2);
}
let id = 0;
async function rpc(method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  const json = JSON.parse(text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:")).slice(5) : text);
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-call", version: "0" } });
if (tool === "--list") {
  const r = await rpc("tools/list", {});
  for (const t of r.tools) console.log(`${t.name}\t${JSON.stringify(t.annotations ?? {})}`);
} else {
  const r = await rpc("tools/call", { name: tool, arguments: JSON.parse(argsJson) });
  const text = r.content?.map((c) => c.text).join("\n") ?? "";
  console.log(text);
  if (r.isError) process.exit(1);
}
