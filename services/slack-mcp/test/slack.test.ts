import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowedTools, DEFAULT_ALLOWLIST, isAllowed } from "../src/policy.js";
import { parseTokenResponse, READ_SCOPES, TokenStore, writeScopes } from "../src/tokens.js";

const tool = (name: string) => ({ name, inputSchema: { type: "object" as const }, annotations: { readOnlyHint: false } });

describe("slack-mcp policy", () => {
  it("exposes only allowlisted read tools, annotated read-only", () => {
    const upstream = ["slack_search_public_and_private", "slack_read_thread", "slack_send_message", "slack_send_message_draft", "slack_add_reaction", "slack_create_canvas"].map(tool);
    const out = allowedTools(upstream, new Set(DEFAULT_ALLOWLIST));
    expect(out.map((t) => t.name)).toEqual(["slack_search_public_and_private", "slack_read_thread"]);
    expect(out.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.openWorldHint === false)).toBe(true);
  });

  it("never allows mutating tools even if allowlisted", () => {
    const allow = new Set([...DEFAULT_ALLOWLIST, "slack_send_message", "slack_schedule_message", "slack_update_canvas", "slack_add_list_record"]);
    for (const n of ["slack_send_message", "slack_schedule_message", "slack_update_canvas", "slack_add_list_record"]) expect(isAllowed(n, allow)).toBe(false);
    for (const n of DEFAULT_ALLOWLIST) expect(isAllowed(n, allow)).toBe(true);
  });

  it("requests no write scopes", () => {
    expect(writeScopes(READ_SCOPES.join(" "))).toEqual([]);
    expect(writeScopes("chat:write channels:history reactions:write")).toEqual(["chat:write", "reactions:write"]);
  });
});

describe("token handling", () => {
  it("parses top-level and authed_user token responses", () => {
    const now = 1_000_000;
    expect(parseTokenResponse({ ok: true, access_token: "user-token-a", refresh_token: "r1", expires_in: 43200, scope: "search:read.public", user_id: "U1" }, now)).toMatchObject({ access_token: "user-token-a", refresh_token: "r1", expires_at: now + 43_200_000, user_id: "U1" });
    expect(parseTokenResponse({ ok: true, authed_user: { id: "U2", access_token: "user-token-b", scope: "x" }, team: { id: "T1" } }, now)).toMatchObject({ access_token: "user-token-b", user_id: "U2", team_id: "T1" });
    expect(() => parseTokenResponse({ ok: false, error: "invalid_refresh_token" })).toThrow(/invalid_refresh_token/);
  });

  it("refreshes an expiring token and persists the rotated refresh token (0600)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slack-mcp-"));
    const file = join(dir, "token.json");
    writeFileSync(file, JSON.stringify({ access_token: "old", refresh_token: "r-old", expires_at: Date.now() + 1000 }));
    const calls: string[] = [];
    const fakeFetch = (async (_url: string, init: { body: URLSearchParams }) => {
      calls.push(init.body.get("refresh_token")!);
      return new Response(JSON.stringify({ ok: true, access_token: "new", refresh_token: "r-new", expires_in: 43200 }));
    }) as unknown as typeof fetch;
    const store = new TokenStore(file, "client", fakeFetch);
    const [a, b] = await Promise.all([store.accessToken(), store.accessToken()]);
    expect([a, b]).toEqual(["new", "new"]);
    expect(calls).toEqual(["r-old"]); // one refresh shared by concurrent callers
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toMatchObject({ access_token: "new", refresh_token: "r-new" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
