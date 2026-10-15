import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowedTools, DEFAULT_ALLOWLIST, isAllowed, READ_TOOLS } from "../src/policy.js";
import { SignIn, SignInError } from "../src/signin.js";
import { parseTokenResponse, TokenStore } from "../src/tokens.js";

const tool = (name: string) => ({ name, inputSchema: { type: "object" as const }, annotations: { readOnlyHint: false, openWorldHint: true } });
const tmp = () => mkdtempSync(join(tmpdir(), "glean-mcp-"));

describe("glean-mcp policy", () => {
  // The tools Glean's default server offers, plus gateway tools that act in other apps.
  const upstreamNames = [...READ_TOOLS, "user_activity", "memory", "memory_schema", "create_image", "edit_image", "share_artifact", "update_artifact", "upload_artifact", "slack_send_message"];

  it("exposes only the read tools, annotated read-only and closed-world", () => {
    const out = allowedTools(upstreamNames.map(tool), new Set(DEFAULT_ALLOWLIST));
    expect(out.map((t) => t.name)).toEqual(READ_TOOLS);
    for (const t of out) expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false, destructiveHint: false });
  });

  it("never allows writes, memory, artifacts or sends, even if allowlisted", () => {
    const bad = ["memory", "create_image", "share_artifact", "upload_artifact", "slack_send_message", "jira_create_issue", "gmail_send", "calendar_update_event", "delete_document"];
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

  it("refreshes once for concurrent callers and persists the new pair (0600)", async () => {
    const file = join(tmp(), "token.json");
    writeFileSync(file, JSON.stringify({ access_token: "old", refresh_token: "r-old", expires_at: Date.now() + 1000, client_id: "c", token_endpoint: "https://g.example/token", resource: "https://g.example/mcp/default" }));
    const seen: URLSearchParams[] = [];
    const fakeFetch = (async (_url: string, init: { body: URLSearchParams }) => {
      seen.push(init.body);
      return new Response(JSON.stringify({ access_token: "new", refresh_token: "r-new", expires_in: 3600 }));
    }) as unknown as typeof fetch;
    const store = new TokenStore(file, fakeFetch);
    expect(await Promise.all([store.accessToken(), store.accessToken()])).toEqual(["new", "new"]);
    expect(seen).toHaveLength(1);
    expect(Object.fromEntries(seen[0]!)).toMatchObject({ grant_type: "refresh_token", refresh_token: "r-old", client_id: "c", resource: "https://g.example/mcp/default" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ access_token: "new", refresh_token: "r-new" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("reports missing, then expired when Glean refuses the refresh, but not on a 5xx", async () => {
    const file = join(tmp(), "token.json");
    let status = 400;
    const fakeFetch = (async () => new Response(JSON.stringify(status === 400 ? { error: "invalid_grant" } : {}), { status })) as unknown as typeof fetch;
    const store = new TokenStore(file, fakeFetch);
    expect(store.status().state).toBe("missing");
    writeFileSync(file, JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: 1, client_id: "c", token_endpoint: "https://g.example/token" }));
    status = 503;
    await expect(store.accessToken()).rejects.toThrow();
    expect(store.status().state).toBe("unknown");
    status = 400;
    await expect(store.accessToken()).rejects.toThrow(/invalid_grant/);
    expect(store.status()).toMatchObject({ state: "expired", detail: "Glean OAuth error: invalid_grant" });
  });
});

describe("sign-in", () => {
  const MCP = "https://acme-be.glean.com/mcp/default";
  function fakeGlean(opts: { register?: boolean } = {}) {
    const calls: { url: string; body?: string }[] = [];
    const fetchImpl = (async (url: string, init?: { body?: unknown }) => {
      calls.push({ url, body: init?.body === undefined ? undefined : String(init.body) });
      if (url === "https://acme-be.glean.com/.well-known/oauth-protected-resource/mcp/default")
        return Response.json({ resource: MCP, authorization_servers: ["https://acme-be.glean.com/oauth"], scopes_supported: ["MCP", "SEARCH"] });
      if (url === "https://acme-be.glean.com/.well-known/oauth-authorization-server/oauth")
        return Response.json({ issuer: "https://acme-be.glean.com/oauth", authorization_endpoint: "https://acme.glean.com/oauth/authorize", token_endpoint: "https://acme-be.glean.com/oauth/token", scopes_supported: ["mcp", "search", "offline_access"], ...(opts.register === false ? {} : { registration_endpoint: "https://acme-be.glean.com/oauth/register" }) });
      if (url === "https://acme-be.glean.com/oauth/register") return Response.json({ client_id: "pw-client" }, { status: 201 });
      if (url === "https://acme-be.glean.com/oauth/token") return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "MCP SEARCH offline_access" });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("discovers the server, registers once, and stores the token from the board's callback", async () => {
    const dir = tmp();
    const { calls, fetchImpl } = fakeGlean();
    const tokens = new TokenStore(join(dir, "token.json"));
    const signIn = new SignIn(MCP, join(dir, "client.json"), tokens, fetchImpl);
    const { url } = await signIn.start("http://127.0.0.1:3120/glean/callback");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://acme.glean.com/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: "pw-client", redirect_uri: "http://127.0.0.1:3120/glean/callback", code_challenge_method: "S256", resource: MCP, scope: "MCP SEARCH offline_access" });
    expect(statSync(join(dir, "client.json")).mode & 0o777).toBe(0o600);

    await signIn.finish(u.searchParams.get("state")!, "the-code");
    const token = calls.find((c) => c.url.endsWith("/oauth/token"))!;
    expect(Object.fromEntries(new URLSearchParams(token.body))).toMatchObject({ grant_type: "authorization_code", code: "the-code", client_id: "pw-client", redirect_uri: "http://127.0.0.1:3120/glean/callback" });
    expect(JSON.parse(readFileSync(join(dir, "token.json"), "utf8"))).toMatchObject({ access_token: "at", refresh_token: "rt", client_id: "pw-client", token_endpoint: "https://acme-be.glean.com/oauth/token", resource: MCP });
    expect(tokens.status().state).toBe("ok");

    // A second sign-in reuses the registered client; a used state is refused.
    await signIn.start("http://127.0.0.1:3120/glean/callback");
    expect(calls.filter((c) => c.url.endsWith("/register"))).toHaveLength(1);
    await expect(signIn.finish(u.searchParams.get("state")!, "again")).rejects.toThrow(SignInError);
  });

  it("refuses non-loopback redirects and servers without registration", async () => {
    const dir = tmp();
    const signIn = new SignIn(MCP, join(dir, "client.json"), new TokenStore(join(dir, "token.json")), fakeGlean({ register: false }).fetchImpl);
    await expect(signIn.start("https://evil.example/cb")).rejects.toThrow(/loopback/);
    await expect(signIn.start("http://127.0.0.1:3120/glean/callback")).rejects.toThrow(/registration/);
    expect(existsSync(join(dir, "client.json"))).toBe(false);
  });
});
