import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowedTools, DEFAULT_ALLOWLIST, isAllowed, PUBLISH_TOOLS, READ_TOOLS } from "../src/policy.js";
import { parseTokenResponse, TokenStore } from "../src/tokens.js";

const tool = (name: string) => ({ name, inputSchema: { type: "object" as const }, annotations: { readOnlyHint: false, openWorldHint: true } });
const tmp = () => mkdtempSync(join(tmpdir(), "primer-mcp-"));

describe("primer-mcp policy", () => {
  const upstreamNames = [...READ_TOOLS, ...PUBLISH_TOOLS, "primer_send_events", "primer_get_events", "primer_get_all_comments"];

  it("exposes only allowlisted tools; reads read-only, publishing as a closed-world write", () => {
    const out = allowedTools(upstreamNames.map(tool), new Set(DEFAULT_ALLOWLIST));
    expect(out.map((t) => t.name)).toEqual(DEFAULT_ALLOWLIST);
    for (const t of out) {
      expect(t.annotations?.readOnlyHint).toBe(!PUBLISH_TOOLS.includes(t.name));
      expect(t.annotations?.openWorldHint).toBe(false);
      expect(t.annotations?.destructiveHint).toBe(false);
    }
  });

  it("never allows deleting, sharing or page events, even if allowlisted", () => {
    const bad = ["primer_send_events", "primer_delete_document", "primer_share_document", "primer_set_visibility", "primer_add_collaborator", "primer_create_token"];
    const allow = new Set([...DEFAULT_ALLOWLIST, ...bad]);
    for (const n of bad) expect(isAllowed(n, allow)).toBe(false);
    for (const n of DEFAULT_ALLOWLIST) expect(isAllowed(n, allow)).toBe(true);
  });
});

describe("token handling", () => {
  it("parses token responses and errors", () => {
    expect(parseTokenResponse({ access_token: "a", refresh_token: "r", expires_in: 3600 }, 1000)).toMatchObject({ access_token: "a", refresh_token: "r", expires_at: 1000 + 3_600_000 });
    expect(() => parseTokenResponse({ error: "invalid_grant" })).toThrow(/invalid_grant/);
  });

  it("refreshes with the registered client and persists the new pair (0600)", async () => {
    const file = join(tmp(), "token.json");
    writeFileSync(file, JSON.stringify({ access_token: "old", refresh_token: "r-old", expires_at: Date.now() + 1000, client_id: "client_x", token_endpoint: "https://tg.example/token", resource: "https://tg.example/mcp" }));
    const seen: URLSearchParams[] = [];
    const fakeFetch = (async (url: string, init: { body: URLSearchParams }) => {
      expect(url).toBe("https://tg.example/token");
      seen.push(init.body);
      return new Response(JSON.stringify({ access_token: "new", refresh_token: "r-new", expires_in: 3600 }));
    }) as unknown as typeof fetch;
    const store = new TokenStore(file, fakeFetch);
    expect(await Promise.all([store.accessToken(), store.accessToken()])).toEqual(["new", "new"]);
    expect(seen).toHaveLength(1);
    expect(Object.fromEntries(seen[0]!)).toMatchObject({ grant_type: "refresh_token", refresh_token: "r-old", client_id: "client_x", resource: "https://tg.example/mcp" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ access_token: "new", refresh_token: "r-new", client_id: "client_x" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
