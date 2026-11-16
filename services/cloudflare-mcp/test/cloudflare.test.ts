import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowedTools, DEFAULT_ALLOWLIST, isAllowed, READ_TOOLS, readScopes, truncateResult, writeScopes } from "../src/policy.js";
import { SignIn, SignInError } from "../src/signin.js";
import { TokenStore } from "../src/tokens.js";

const tool = (name: string) => ({ name, inputSchema: { type: "object" as const }, annotations: { readOnlyHint: false, openWorldHint: true } });
const tmp = () => mkdtempSync(join(tmpdir(), "cloudflare-mcp-"));
// The scopes mcp.cloudflare.com offered on 2026-11-16.
const SUPPORTED = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/scopes.json"), "utf8")) as string[];

describe("cloudflare-mcp policy", () => {
  it("asks for every read scope Cloudflare offers, and nothing that changes anything", () => {
    const reads = readScopes(SUPPORTED);
    expect(reads.length).toBe(200);
    expect(reads).toEqual(expect.arrayContaining(["user:read", "account:read", "dns.read", "workers-scripts.read", "workers-scripts.content_read", "workers-r2.metadata_read", "access-app.read", "logs.read"]));
    for (const s of reads) expect(s, s).toMatch(/[.:](read|metadata_read|content_read)$/);
    const left = SUPPORTED.filter((s) => !reads.includes(s));
    expect(left).toEqual(expect.arrayContaining(["dns.write", "cache.purge", "access.revoke", "workers-scripts.edit", "workers-scripts.admin", "ai.write", "page.shield", "pipelines.send", "account-api-tokens.write"]));
  });

  it("finds anything but reads in a granted scope list", () => {
    expect(writeScopes("user:read dns.read offline_access workers-scripts.content_read")).toEqual([]);
    expect(writeScopes("dns.read dns.write cache.purge")).toEqual(["dns.write", "cache.purge"]);
  });

  it("exposes Code Mode's tools, annotated read-only and closed-world", () => {
    const out = allowedTools([...READ_TOOLS, "workers_deploy", "dns_records_update"].map(tool), new Set(DEFAULT_ALLOWLIST));
    expect(out.map((t) => t.name)).toEqual(READ_TOOLS);
    for (const t of out) expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false, destructiveHint: false });
    expect(isAllowed("purge_cache", new Set(["purge_cache"]))).toBe(false);
  });

  it("cuts long answers with a note, and drops their structured copy", () => {
    const long = { content: [{ type: "text", text: "x".repeat(50) }], structuredContent: { rows: [] } };
    const out = truncateResult(long, 20) as { content: { text: string }[]; structuredContent?: unknown };
    expect(out.content[0]!.text).toBe("x".repeat(20));
    expect(out.content.at(-1)!.text).toMatch(/cut this answer at 20/);
    expect(out.structuredContent).toBeUndefined();
  });
});

describe("sign-in", () => {
  // Shaped like mcp.cloudflare.com on 2026-11-16.
  const MCP = "https://mcp.cloudflare.com/mcp";
  function fakeCloudflare(opts: { register?: boolean; granted?: string } = {}) {
    const calls: { url: string; body?: string }[] = [];
    const fetchImpl = (async (url: string, init?: { body?: unknown }) => {
      calls.push({ url, body: init?.body === undefined ? undefined : String(init.body) });
      if (url === MCP) return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="OAuth", resource_metadata="https://mcp.cloudflare.com/.well-known/oauth-protected-resource/mcp", scope="user:read account:read"' } });
      if (url === "https://mcp.cloudflare.com/.well-known/oauth-protected-resource/mcp")
        return Response.json({ resource: MCP, authorization_servers: ["https://mcp.cloudflare.com"], scopes_supported: ["user:read", "account:read"] });
      if (url === "https://mcp.cloudflare.com/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: "https://mcp.cloudflare.com",
          authorization_endpoint: "https://mcp.cloudflare.com/authorize",
          token_endpoint: "https://mcp.cloudflare.com/token",
          scopes_supported: SUPPORTED,
          ...(opts.register === false ? {} : { registration_endpoint: "https://mcp.cloudflare.com/register" }),
        });
      if (url === "https://mcp.cloudflare.com/register") return Response.json({ client_id: "pw-client", token_endpoint_auth_method: "none" });
      if (url === "https://mcp.cloudflare.com/token") return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: opts.granted ?? "user:read account:read dns.read offline_access" });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("finds the sign-in server, asks for the read scopes only, and stores the token", async () => {
    const dir = tmp();
    const { calls, fetchImpl } = fakeCloudflare();
    const tokens = new TokenStore(join(dir, "token.json"));
    const signIn = new SignIn(MCP, join(dir, "client.json"), tokens, fetchImpl);
    const { url } = await signIn.start("http://127.0.0.1:3120/cloudflare/callback");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://mcp.cloudflare.com/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: "pw-client", redirect_uri: "http://127.0.0.1:3120/cloudflare/callback", code_challenge_method: "S256", resource: MCP });
    expect(u.searchParams.get("scope")!.split(" ")).toEqual([...readScopes(SUPPORTED), "offline_access"]);
    expect(statSync(join(dir, "client.json")).mode & 0o777).toBe(0o600);

    await signIn.finish(u.searchParams.get("state")!, "the-code");
    const token = calls.find((c) => c.url.endsWith("/token"))!;
    expect(Object.fromEntries(new URLSearchParams(token.body))).toMatchObject({ grant_type: "authorization_code", code: "the-code", client_id: "pw-client", resource: MCP });
    expect(JSON.parse(readFileSync(join(dir, "token.json"), "utf8"))).toMatchObject({ access_token: "at", refresh_token: "rt", client_id: "pw-client", token_endpoint: "https://mcp.cloudflare.com/token", resource: MCP });
    expect(tokens.status().state).toBe("ok");
    await expect(signIn.finish(u.searchParams.get("state")!, "again")).rejects.toThrow(SignInError);
  });

  it("refuses a sign-in that comes back with write scopes, and keeps no token", async () => {
    const dir = tmp();
    const signIn = new SignIn(MCP, join(dir, "client.json"), new TokenStore(join(dir, "token.json")), fakeCloudflare({ granted: "user:read dns.read dns.write" }).fetchImpl);
    const { url } = await signIn.start("http://127.0.0.1:3120/cloudflare/callback");
    await expect(signIn.finish(new URL(url).searchParams.get("state")!, "c")).rejects.toThrow(/dns\.write/);
    expect(existsSync(join(dir, "token.json"))).toBe(false);
  });

  it("refuses non-loopback redirects and servers without registration", async () => {
    const dir = tmp();
    const signIn = new SignIn(MCP, join(dir, "client.json"), new TokenStore(join(dir, "token.json")), fakeCloudflare({ register: false }).fetchImpl);
    await expect(signIn.start("https://evil.example/cb")).rejects.toThrow(/loopback/);
    await expect(signIn.start("http://127.0.0.1:3120/cloudflare/callback")).rejects.toThrow(/registration/);
    expect(existsSync(join(dir, "client.json"))).toBe(false);
  });
});
