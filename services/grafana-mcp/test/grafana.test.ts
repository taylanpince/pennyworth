import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowedTools, DEFAULT_ALLOWLIST, isAllowed, READ_TOOLS, SCOPES } from "../src/policy.js";
import { SignIn, SignInError } from "../src/signin.js";
import { parseTokenResponse, TokenStore } from "../src/tokens.js";

const tool = (name: string) => ({ name, inputSchema: { type: "object" as const }, annotations: { readOnlyHint: false, openWorldHint: true } });
const tmp = () => mkdtempSync(join(tmpdir(), "grafana-mcp-"));

describe("grafana-mcp policy", () => {
  // Tools Grafana's hosted server offers that change things or act: never exposed.
  const writes = [
    "exec_gcx", "update_dashboard", "create_dashboard", "create_incident", "add_activity_to_incident", "update_incident", "resolve_incident",
    "alerting_manage_routing", "alerting_manage_rules", "create_alert_rule", "render_alert_creation", "create_silence", "delete_silence",
    "create_investigation", "wait_for_investigation", "assistant_search", "kubernetes_handler", "app_observability_handler",
    "frontend_observability_handler", "query_sql", "create_annotation", "update_annotation", "patch_annotation", "agento11y_manage_agents",
  ];

  it("exposes only the read tools, annotated read-only and closed-world", () => {
    const out = allowedTools([...READ_TOOLS, ...writes].map(tool), new Set(DEFAULT_ALLOWLIST));
    expect(out.map((t) => t.name)).toEqual(READ_TOOLS);
    for (const t of out) expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false, destructiveHint: false });
  });

  it("never allows writes, gcx, investigations or handlers, even if allowlisted", () => {
    const allow = new Set([...DEFAULT_ALLOWLIST, ...writes]);
    for (const n of writes) expect(isAllowed(n, allow), n).toBe(false);
    for (const n of DEFAULT_ALLOWLIST) expect(isAllowed(n, allow), n).toBe(true);
  });

  it("asks for read and query scopes only, never write", () => {
    expect(SCOPES).toEqual(["grafana:read", "grafana:query"]);
    expect(SCOPES.join(" ")).not.toMatch(/write/);
  });
});

describe("token handling", () => {
  it("parses token responses and errors", () => {
    expect(parseTokenResponse({ access_token: "a", refresh_token: "r", expires_in: 3600 }, 1000)).toMatchObject({ access_token: "a", refresh_token: "r", expires_at: 1000 + 3_600_000 });
    expect(() => parseTokenResponse({ error: "invalid_grant" })).toThrow(/invalid_grant/);
  });

  it("refreshes once for concurrent callers and persists the new pair (0600)", async () => {
    const file = join(tmp(), "token.json");
    writeFileSync(file, JSON.stringify({ access_token: "old", refresh_token: "r-old", expires_at: Date.now() + 1000, client_id: "c", token_endpoint: "https://mcp.example/mcp/oauth/token", resource: "https://mcp.example/mcp" }));
    const seen: URLSearchParams[] = [];
    const fakeFetch = (async (_url: string, init: { body: URLSearchParams }) => {
      seen.push(init.body);
      return new Response(JSON.stringify({ access_token: "new", refresh_token: "r-new", expires_in: 3600 }));
    }) as unknown as typeof fetch;
    const store = new TokenStore(file, fakeFetch);
    expect(await Promise.all([store.accessToken(), store.accessToken()])).toEqual(["new", "new"]);
    expect(seen).toHaveLength(1);
    expect(Object.fromEntries(seen[0]!)).toMatchObject({ grant_type: "refresh_token", refresh_token: "r-old", client_id: "c", resource: "https://mcp.example/mcp" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ access_token: "new", refresh_token: "r-new" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("reports missing, then expired when Grafana refuses the refresh, but not on a 5xx", async () => {
    const file = join(tmp(), "token.json");
    let status = 400;
    const fakeFetch = (async () => new Response(JSON.stringify(status === 400 ? { error: "invalid_grant" } : {}), { status })) as unknown as typeof fetch;
    const store = new TokenStore(file, fakeFetch);
    expect(store.status().state).toBe("missing");
    writeFileSync(file, JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: 1, client_id: "c", token_endpoint: "https://mcp.example/mcp/oauth/token" }));
    status = 503;
    await expect(store.accessToken()).rejects.toThrow();
    expect(store.status().state).toBe("unknown");
    status = 400;
    await expect(store.accessToken()).rejects.toThrow(/invalid_grant/);
    expect(store.status()).toMatchObject({ state: "expired", detail: "Grafana OAuth error: invalid_grant" });
  });
});

describe("sign-in", () => {
  // Shaped like mcp.grafana.com on 2026-10-26: a per-stack authorization server under /mcp/gurl/<stack>.
  const MCP = "https://mcp.grafana.com/mcp";
  const STACK = "https://acme.grafana.net";
  const GURL = "https://mcp.grafana.com/mcp/gurl/YWNtZQ";
  function fakeGrafana(opts: { register?: boolean; grantWrite?: boolean } = {}) {
    const calls: { url: string; body?: string; headers?: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init?: { body?: unknown; headers?: Record<string, string> }) => {
      calls.push({ url, body: init?.body === undefined ? undefined : String(init.body), headers: init?.headers });
      if (url === MCP)
        return new Response('{"error":"invalid_token"}', { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.grafana.com/.well-known/oauth-protected-resource/mcp/gurl/YWNtZQ"' } });
      if (url === "https://mcp.grafana.com/.well-known/oauth-protected-resource/mcp/gurl/YWNtZQ")
        return Response.json({ resource: MCP, authorization_servers: [GURL], scopes_supported: ["grafana:read", "grafana:query", "grafana:write"] });
      if (url === "https://mcp.grafana.com/.well-known/oauth-authorization-server/mcp/gurl/YWNtZQ")
        return Response.json({
          issuer: GURL,
          authorization_endpoint: `https://mcp.grafana.com/mcp/oauth/authorize?grafana_url=${encodeURIComponent(STACK)}`,
          token_endpoint: "https://mcp.grafana.com/mcp/oauth/token",
          scopes_supported: ["grafana:read", "grafana:query", "grafana:write"],
          ...(opts.register === false ? {} : { registration_endpoint: "https://mcp.grafana.com/mcp/oauth/register" }),
        });
      if (url === "https://mcp.grafana.com/mcp/oauth/register") return Response.json({ client_id: "pw-client" }, { status: 201 });
      if (url === "https://mcp.grafana.com/mcp/oauth/token") return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: opts.grantWrite ? "grafana:read grafana:write" : "grafana:read grafana:query" });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("finds the stack's sign-in server, keeps its grafana_url, asks for read and query only, and stores the token", async () => {
    const dir = tmp();
    const { calls, fetchImpl } = fakeGrafana();
    const tokens = new TokenStore(join(dir, "token.json"));
    const signIn = new SignIn(MCP, STACK, join(dir, "client.json"), tokens, fetchImpl);
    const { url } = await signIn.start("http://127.0.0.1:3120/grafana/callback");
    expect(calls[0]).toMatchObject({ url: MCP, headers: { "x-grafana-url": STACK } });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://mcp.grafana.com/mcp/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ grafana_url: STACK, client_id: "pw-client", redirect_uri: "http://127.0.0.1:3120/grafana/callback", code_challenge_method: "S256", resource: MCP, scope: "grafana:read grafana:query" });
    expect(statSync(join(dir, "client.json")).mode & 0o777).toBe(0o600);

    await signIn.finish(u.searchParams.get("state")!, "the-code");
    const token = calls.find((c) => c.url.endsWith("/oauth/token"))!;
    expect(Object.fromEntries(new URLSearchParams(token.body))).toMatchObject({ grant_type: "authorization_code", code: "the-code", client_id: "pw-client", redirect_uri: "http://127.0.0.1:3120/grafana/callback", resource: MCP });
    expect(JSON.parse(readFileSync(join(dir, "token.json"), "utf8"))).toMatchObject({ access_token: "at", refresh_token: "rt", client_id: "pw-client", token_endpoint: "https://mcp.grafana.com/mcp/oauth/token", resource: MCP });
    expect(tokens.status().state).toBe("ok");

    // A second sign-in reuses the registered client; a used state is refused.
    await signIn.start("http://127.0.0.1:3120/grafana/callback");
    expect(calls.filter((c) => c.url.endsWith("/register"))).toHaveLength(1);
    await expect(signIn.finish(u.searchParams.get("state")!, "again")).rejects.toThrow(SignInError);
  });

  it("refuses a sign-in that came back with write access", async () => {
    const dir = tmp();
    const signIn = new SignIn(MCP, STACK, join(dir, "client.json"), new TokenStore(join(dir, "token.json")), fakeGrafana({ grantWrite: true }).fetchImpl);
    const { url } = await signIn.start("http://127.0.0.1:3120/grafana/callback");
    await expect(signIn.finish(new URL(url).searchParams.get("state")!, "c")).rejects.toThrow(/write/);
    expect(existsSync(join(dir, "token.json"))).toBe(false);
  });

  it("refuses non-loopback redirects and servers without registration", async () => {
    const dir = tmp();
    const signIn = new SignIn(MCP, STACK, join(dir, "client.json"), new TokenStore(join(dir, "token.json")), fakeGrafana({ register: false }).fetchImpl);
    await expect(signIn.start("https://evil.example/cb")).rejects.toThrow(/loopback/);
    await expect(signIn.start("http://127.0.0.1:3120/grafana/callback")).rejects.toThrow(/registration/);
    expect(existsSync(join(dir, "client.json"))).toBe(false);
  });
});
