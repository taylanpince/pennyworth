import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SignIn, SignInError } from "../src/signin.js";
import { TokenStore } from "../src/tokens.js";

// Shaped like primer.polygon.tools on 2026-11-16.
const MCP = "https://primer.example/mcp";
function fakePrimer(opts: { register?: boolean } = {}) {
  const calls: { url: string; body?: string }[] = [];
  const fetchImpl = (async (url: string, init?: { body?: unknown }) => {
    calls.push({ url, body: init?.body === undefined ? undefined : String(init.body) });
    if (url === "https://primer.example/.well-known/oauth-authorization-server")
      return Response.json({ issuer: "https://primer.example", authorization_endpoint: "https://primer.example/oauth/authorize", token_endpoint: "https://primer.example/oauth/token", scopes_supported: ["primer"], ...(opts.register === false ? {} : { registration_endpoint: "https://primer.example/oauth/register" }) });
    if (url === "https://primer.example/oauth/register") return Response.json({ client_id: "pw", token_endpoint_auth_method: "none" });
    if (url === "https://primer.example/oauth/token") return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("Primer sign-in from the board (D-66)", () => {
  it("registers for the board's callback, signs in with Primer's default scope, and stores the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "primer-signin-"));
    const { calls, fetchImpl } = fakePrimer();
    const tokens = new TokenStore(join(dir, "token.json"));
    const signIn = new SignIn(MCP, join(dir, "client.json"), tokens, fetchImpl);
    const { url } = await signIn.start("http://127.0.0.1:3120/primer/callback");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://primer.example/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: "pw", redirect_uri: "http://127.0.0.1:3120/primer/callback", resource: MCP, code_challenge_method: "S256" });
    expect(u.searchParams.has("scope")).toBe(false);
    expect(statSync(join(dir, "client.json")).mode & 0o777).toBe(0o600);
    await signIn.finish(u.searchParams.get("state")!, "code");
    expect(JSON.parse(readFileSync(join(dir, "token.json"), "utf8"))).toMatchObject({ access_token: "at", refresh_token: "rt", client_id: "pw", token_endpoint: "https://primer.example/oauth/token" });
    expect(tokens.status().state).toBe("ok");
    expect(calls.some((c) => c.url.endsWith("/oauth/token"))).toBe(true);
    await expect(signIn.finish(u.searchParams.get("state")!, "again")).rejects.toThrow(SignInError);
  });

  it("refuses non-loopback redirects and servers without registration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "primer-signin-"));
    const signIn = new SignIn(MCP, join(dir, "client.json"), new TokenStore(join(dir, "token.json")), fakePrimer({ register: false }).fetchImpl);
    await expect(signIn.start("https://evil.example/cb")).rejects.toThrow(/loopback/);
    await expect(signIn.start("http://127.0.0.1:3120/primer/callback")).rejects.toThrow(/registration/);
    expect(existsSync(join(dir, "client.json"))).toBe(false);
  });
});
