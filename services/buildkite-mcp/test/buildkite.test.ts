import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowedTools, DEFAULT_ALLOWLIST, isAllowed, READ_TOOLS, readScopes, truncateResult, writeScopes } from "../src/policy.js";
import { SignIn, SignInError } from "../src/signin.js";
import { TokenStore } from "../src/tokens.js";

const tool = (name: string) => ({ name, inputSchema: { type: "object" as const }, annotations: { readOnlyHint: false, openWorldHint: true } });
const tmp = () => mkdtempSync(join(tmpdir(), "buildkite-mcp-"));
// The write tools Buildkite documented on 2026-11-24, and the reads left out on purpose.
const WRITES = ["create_build", "create_pipeline", "create_pipeline_schedule", "create_cluster", "create_cluster_queue", "create_cluster_secret", "create_cache_registry", "cancel_build", "rebuild_build", "retry_job", "unblock_job", "update_pipeline", "update_pipeline_schedule", "update_cluster", "update_cluster_queue", "pause_cluster_queue_dispatch", "resume_cluster_queue_dispatch", "update_cache_registry", "set_default_cache_registry", "delete_cache_registry", "create_annotation"];
const SENSITIVE = ["access_token", "get_job_env", "list_cluster_secrets", "get_cluster_secret"];

describe("buildkite-mcp policy", () => {
  it("asks for the read scope only", () => {
    expect(readScopes(["read", "write"])).toEqual(["read"]);
    expect(readScopes(["write"])).toEqual([]);
  });

  it("finds anything but reads in a granted scope list", () => {
    expect(writeScopes("read")).toEqual([]);
    expect(writeScopes("read_builds read_build_logs offline_access")).toEqual([]);
    expect(writeScopes("read write")).toEqual(["write"]);
    expect(writeScopes("read_builds write_builds")).toEqual(["write_builds"]);
  });

  it("exposes the read tools only, annotated read-only and closed-world", () => {
    const out = allowedTools([...READ_TOOLS, ...WRITES, ...SENSITIVE].map(tool), new Set(DEFAULT_ALLOWLIST));
    expect(out.map((t) => t.name)).toEqual(READ_TOOLS);
    for (const t of out) expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false, destructiveHint: false });
  });

  it("never exposes a write or a secret, even when allowlisted", () => {
    for (const name of [...WRITES, ...SENSITIVE]) expect(isAllowed(name, new Set([name])), name).toBe(false);
    expect(isAllowed("user_token_organization", new Set(DEFAULT_ALLOWLIST))).toBe(true);
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
  // Shaped like mcp.buildkite.com on 2026-11-24.
  const MCP = "https://mcp.buildkite.com/mcp/readonly";
  function fakeBuildkite(opts: { register?: boolean; granted?: string } = {}) {
    const calls: { url: string; body?: string }[] = [];
    const fetchImpl = (async (url: string, init?: { body?: unknown }) => {
      calls.push({ url, body: init?.body === undefined ? undefined : String(init.body) });
      if (url === MCP)
        return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="https://mcp.buildkite.com", error="access_denied", error_description="Authentication required", resource_metadata="https://mcp.buildkite.com/.well-known/oauth-protected-resource/mcp/readonly"' } });
      if (url === "https://mcp.buildkite.com/.well-known/oauth-protected-resource/mcp/readonly") return Response.json({ resource: MCP, authorization_servers: ["https://mcp.buildkite.com"], bearer_methods_supported: ["header"] });
      if (url === "https://mcp.buildkite.com/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: "https://mcp.buildkite.com",
          authorization_endpoint: "https://mcp.buildkite.com/oauth/authorize",
          token_endpoint: "https://mcp.buildkite.com/oauth/token",
          scopes_supported: ["read", "write"],
          ...(opts.register === false ? {} : { registration_endpoint: "https://mcp.buildkite.com/oauth/register" }),
        });
      if (url === "https://mcp.buildkite.com/oauth/register") return Response.json({ client_id: "pw-client", token_endpoint_auth_method: "none" });
      if (url === "https://mcp.buildkite.com/oauth/token") return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: opts.granted ?? "read" });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("finds the sign-in server, asks for read only, and stores the token", async () => {
    const dir = tmp();
    const { calls, fetchImpl } = fakeBuildkite();
    const tokens = new TokenStore(join(dir, "token.json"));
    const signIn = new SignIn(MCP, join(dir, "client.json"), tokens, fetchImpl);
    const { url } = await signIn.start("http://127.0.0.1:3120/buildkite/callback");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://mcp.buildkite.com/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: "pw-client", redirect_uri: "http://127.0.0.1:3120/buildkite/callback", code_challenge_method: "S256", resource: MCP, scope: "read" });
    expect(statSync(join(dir, "client.json")).mode & 0o777).toBe(0o600);

    await signIn.finish(u.searchParams.get("state")!, "the-code");
    const token = calls.find((c) => c.url.endsWith("/oauth/token"))!;
    expect(Object.fromEntries(new URLSearchParams(token.body))).toMatchObject({ grant_type: "authorization_code", code: "the-code", client_id: "pw-client", resource: MCP });
    expect(JSON.parse(readFileSync(join(dir, "token.json"), "utf8"))).toMatchObject({ access_token: "at", refresh_token: "rt", client_id: "pw-client", token_endpoint: "https://mcp.buildkite.com/oauth/token", resource: MCP });
    expect(tokens.status().state).toBe("ok");
    await expect(signIn.finish(u.searchParams.get("state")!, "again")).rejects.toThrow(SignInError);
  });

  it("refuses a sign-in that comes back with write, and keeps no token", async () => {
    const dir = tmp();
    const signIn = new SignIn(MCP, join(dir, "client.json"), new TokenStore(join(dir, "token.json")), fakeBuildkite({ granted: "read write" }).fetchImpl);
    const { url } = await signIn.start("http://127.0.0.1:3120/buildkite/callback");
    await expect(signIn.finish(new URL(url).searchParams.get("state")!, "c")).rejects.toThrow(/write/);
    expect(existsSync(join(dir, "token.json"))).toBe(false);
  });

  it("refuses non-loopback redirects and servers without registration", async () => {
    const dir = tmp();
    const signIn = new SignIn(MCP, join(dir, "client.json"), new TokenStore(join(dir, "token.json")), fakeBuildkite({ register: false }).fetchImpl);
    await expect(signIn.start("https://evil.example/cb")).rejects.toThrow(/loopback/);
    await expect(signIn.start("http://127.0.0.1:3120/buildkite/callback")).rejects.toThrow(/registration/);
    expect(existsSync(join(dir, "client.json"))).toBe(false);
  });
});

describe("token refresh", () => {
  it("treats OAuth's try-again-later answers as a passing failure, not a lost sign-in", async () => {
    const { writeFileSync } = await import("node:fs");
    const dir = tmp();
    const path = join(dir, "token.json");
    writeFileSync(path, JSON.stringify({ access_token: "old", refresh_token: "rt", expires_at: 1, client_id: "c", token_endpoint: "https://mcp.buildkite.com/oauth/token" }));
    let answer: { status: number; body: Record<string, unknown> } = { status: 400, body: { error: "temporarily_unavailable" } };
    const store = new TokenStore(path, (async () => Response.json(answer.body, { status: answer.status })) as unknown as typeof fetch);
    await expect(store.refresh()).rejects.toThrow(/temporarily_unavailable/);
    expect(store.status().state).not.toBe("expired");
    answer = { status: 400, body: { error: "invalid_grant" } };
    await expect(store.refresh()).rejects.toThrow(/invalid_grant/);
    expect(store.status().state).toBe("expired");
  });
});
