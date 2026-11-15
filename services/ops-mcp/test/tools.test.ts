import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildServer, type ToolDeps } from "../src/mcp/tools.js";
import { silentLog } from "./helpers.js";

async function connect() {
  const calls: { tool: string; limit: number | undefined }[] = [];
  const deps = {
    meetings: {},
    voice: {},
    log: silentLog,
    vault: { search: (_q: string, limit?: number) => (calls.push({ tool: "obsidian_search", limit }), []) },
    knowledge: { search: (_q: string, _b?: string, limit?: number) => (calls.push({ tool: "knowledge_search", limit }), []) },
  } as unknown as ToolDeps;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(deps).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return { client, calls };
}

describe("search limits", () => {
  it("reads a limit above the most there is as that most, instead of refusing the call", async () => {
    const { client, calls } = await connect();
    for (const name of ["obsidian_search", "knowledge_search"]) {
      const big = await client.callTool({ name, arguments: { query: "roadmap", limit: 200 } });
      expect(big.isError).toBeFalsy();
      const small = await client.callTool({ name, arguments: { query: "roadmap", limit: 5 } });
      expect(small.isError).toBeFalsy();
    }
    await client.callTool({ name: "obsidian_search", arguments: { query: "roadmap" } });
    await client.callTool({ name: "knowledge_search", arguments: { query: "roadmap" } });
    expect(calls).toEqual([
      { tool: "obsidian_search", limit: 50 },
      { tool: "obsidian_search", limit: 5 },
      { tool: "knowledge_search", limit: 50 },
      { tool: "knowledge_search", limit: 5 },
      { tool: "obsidian_search", limit: 20 },
      { tool: "knowledge_search", limit: undefined },
    ]);
  });

  it("still refuses a limit below 1", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "obsidian_search", arguments: { query: "roadmap", limit: 0 } });
    expect(r.isError).toBe(true);
  });
});
