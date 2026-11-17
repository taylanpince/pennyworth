import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Accounts, type CallResult, label, parseSites, parseUser, RouteError, type Upstream } from "../src/accounts.js";
import { allowedTools, DEFAULT_ALLOWLIST, extraScopes, isAllowed, matchesSite, READ_TOOLS, readOnly, SCOPES, siteOf, truncateResult, WRITE_TOOLS } from "../src/policy.js";
import { SignIn, SignInError } from "../src/signin.js";
import type { StoredToken } from "../src/tokens.js";

const tool = (name: string) => ({ name, inputSchema: { type: "object" as const }, annotations: { readOnlyHint: false, openWorldHint: true } });
const tmp = () => mkdtempSync(join(tmpdir(), "jira-mcp-"));
// The scopes mcp.atlassian.com/v2/mcp offered on 2026-11-17.
const SUPPORTED = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/scopes.json"), "utf8")) as string[];
// Tool names of the Rovo MCP server (v1, 2026-11-17), writes and other products included.
const UPSTREAM_TOOLS = [
  ...READ_TOOLS,
  ...WRITE_TOOLS,
  "addWorklogToJiraIssue",
  "createConfluencePage",
  "updateConfluencePage",
  "createConfluenceFooterComment",
  "createConfluenceInlineComment",
  "createCompassComponent",
  "createCompassComponentRelationship",
  "getTeamworkGraphContext",
  "addTeamworkGraphContext",
];

describe("jira-mcp policy", () => {
  it("asks for Jira read, search and write and Confluence reads, never delete, manage or another product", () => {
    for (const s of SCOPES) expect(SUPPORTED, s).toContain(s);
    expect(SCOPES.filter((s) => /^(delete|manage):|write:(?!jira:)/.test(s))).toEqual([]);
    expect(SUPPORTED.filter((s) => !SCOPES.includes(s))).toEqual(expect.arrayContaining(["delete:jira:agent-interface", "manage:jira:agent-interface", "write:confluence:agent-interface", "write:bitbucket:agent-interface", "write:all:twg"]));
    expect(extraScopes("read:me offline_access read:jira:agent-interface write:jira:agent-interface")).toEqual([]);
    expect(extraScopes("read:jira:agent-interface delete:jira:agent-interface write:confluence:agent-interface")).toEqual(["delete:jira:agent-interface", "write:confluence:agent-interface"]);
  });

  it("exposes the reads and the Jira writes on /mcp, the reads only on /mcp/read, and never worklogs or Confluence writes", () => {
    const all = allowedTools(UPSTREAM_TOOLS.map(tool), new Set(DEFAULT_ALLOWLIST));
    expect(all.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    for (const t of all) expect(t.annotations).toMatchObject({ readOnlyHint: !WRITE_TOOLS.includes(t.name), destructiveHint: false, openWorldHint: false });
    const reads = allowedTools(UPSTREAM_TOOLS.map(tool), readOnly(new Set(DEFAULT_ALLOWLIST)));
    expect(reads.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    for (const name of ["addWorklogToJiraIssue", "createConfluencePage", "updateConfluencePage", "deleteJiraIssue", "createCompassComponent"]) expect(isAllowed(name, new Set([name])), name).toBe(false);
  });

  it("finds the site a call is for: cloudId, or the cloud id in an ARI", () => {
    expect(siteOf({ cloudId: "coinme.atlassian.net", issueIdOrKey: "OPS-1" })).toBe("coinme.atlassian.net");
    expect(siteOf({ id: "ari:cloud:jira:0a1b2c3d-0000-4000-8000-123456789abc:issue/10001" })).toBe("0a1b2c3d-0000-4000-8000-123456789abc");
    expect(siteOf({ query: "x" })).toBeUndefined();
    const site = { id: "0a1b2c3d-0000-4000-8000-123456789abc", url: "https://polygon.atlassian.net" };
    for (const ref of ["polygon.atlassian.net", "https://polygon.atlassian.net/", "https://POLYGON.atlassian.net/browse/PT-1", site.id]) expect(matchesSite(ref, site), ref).toBe(true);
    expect(matchesSite("coinme.atlassian.net", site)).toBe(false);
  });

  it("cuts long answers with a note, and drops their structured copy", () => {
    const out = truncateResult({ content: [{ type: "text", text: "x".repeat(50) }], structuredContent: {} }, 20) as { content: { text: string }[]; structuredContent?: unknown };
    expect(out.content[0]!.text).toBe("x".repeat(20));
    expect(out.content.at(-1)!.text).toMatch(/cut this answer at 20/);
    expect(out.structuredContent).toBeUndefined();
  });
});

describe("sign-in", () => {
  // Shaped like mcp.atlassian.com/v2/mcp on 2026-11-17.
  const MCP = "https://mcp.atlassian.com/v2/mcp";
  const AS = "https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3";
  function fakeAtlassian(opts: { granted?: string } = {}) {
    const calls: { url: string; body?: string }[] = [];
    const fetchImpl = (async (url: string, init?: { body?: unknown }) => {
      calls.push({ url, body: init?.body === undefined ? undefined : String(init.body) });
      if (url === MCP) return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp"' } });
      if (url === "https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp") return Response.json({ resource: MCP, authorization_servers: [AS], scopes_supported: SUPPORTED });
      if (url === "https://auth.atlassian.com/.well-known/oauth-authorization-server/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3")
        return Response.json({ issuer: AS, authorization_endpoint: "https://auth.atlassian.com/authorize", token_endpoint: "https://auth.atlassian.com/oauth/token", registration_endpoint: `${AS}/dcr/register`, scopes_supported: null });
      if (url === `${AS}/dcr/register`) return Response.json({ client_id: "pw-client", token_endpoint_auth_method: "none" });
      if (url === "https://auth.atlassian.com/oauth/token") return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: opts.granted ?? "read:me read:jira:agent-interface write:jira:agent-interface offline_access" });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("asks for SCOPES, lets the user pick the account, and hands back the token without storing it", async () => {
    const dir = tmp();
    const { calls, fetchImpl } = fakeAtlassian();
    const signIn = new SignIn(MCP, join(dir, "client.json"), fetchImpl);
    const { url } = await signIn.start("http://127.0.0.1:3120/jira/callback");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://auth.atlassian.com/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: "pw-client", redirect_uri: "http://127.0.0.1:3120/jira/callback", code_challenge_method: "S256", resource: MCP, prompt: "consent" });
    expect(u.searchParams.get("scope")!.split(" ")).toEqual(SCOPES);
    expect(statSync(join(dir, "client.json")).mode & 0o777).toBe(0o600);
    const token = await signIn.finish(u.searchParams.get("state")!, "the-code");
    expect(token).toMatchObject({ access_token: "at", refresh_token: "rt", client_id: "pw-client", token_endpoint: "https://auth.atlassian.com/oauth/token", resource: MCP });
    expect(Object.fromEntries(new URLSearchParams(calls.find((c) => c.url.endsWith("/oauth/token"))!.body))).toMatchObject({ grant_type: "authorization_code", code: "the-code", resource: MCP });
    expect(readdirSync(dir)).toEqual(["client.json"]);
    await expect(signIn.finish(u.searchParams.get("state")!, "again")).rejects.toThrow(SignInError);
  });

  it("refuses a sign-in that comes back with delete or Confluence write access", async () => {
    const signIn = new SignIn(MCP, join(tmp(), "client.json"), fakeAtlassian({ granted: "read:jira:agent-interface delete:jira:agent-interface" }).fetchImpl);
    const { url } = await signIn.start("http://127.0.0.1:3120/jira/callback");
    await expect(signIn.finish(new URL(url).searchParams.get("state")!, "c")).rejects.toThrow(/delete:jira/);
    await expect(signIn.start("https://evil.example/cb")).rejects.toThrow(/loopback/);
  });
});

describe("accounts", () => {
  const POLYGON = { id: "11111111-1111-4111-8111-111111111111", url: "https://polygon.atlassian.net", name: "polygon" };
  const COINME = { id: "22222222-2222-4222-8222-222222222222", url: "https://coinme.atlassian.net", name: "coinme" };
  const people: Record<string, { user: object; sites: object[] }> = {
    polygon: { user: { account_id: "acc-1", email: "taylan@polygon.technology", name: "Taylan" }, sites: [POLYGON] },
    polygon2: { user: { account_id: "acc-1", email: "taylan@polygon.technology", name: "Taylan" }, sites: [POLYGON] },
    coinme: { user: { account_id: "acc-2", email: "taylan@coinme.com", name: "Taylan" }, sites: [COINME] },
  };
  const text = (v: unknown): CallResult => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
  function fake() {
    const calls: { token: string; name: string; args: Record<string, unknown> }[] = [];
    const connector = async (token: string): Promise<Upstream> => ({
      tools: [...READ_TOOLS, ...WRITE_TOOLS].map(tool),
      call: async (name, args) => {
        calls.push({ token, name, args });
        const p = people[token]!;
        if (name === "atlassianUserInfo") return text(p.user);
        if (name === "getAccessibleAtlassianResources") return text(p.sites);
        return text({ ok: token });
      },
      close: async () => undefined,
    });
    return { calls, connector };
  }
  const token = (t: string): StoredToken => ({ access_token: t, refresh_token: `r-${t}`, expires_at: Date.now() + 3600_000, client_id: "c", token_endpoint: "https://auth.atlassian.com/oauth/token" });
  const answer = (r: CallResult) => (r.content ?? []).map((c) => c.text).join("\n");

  it("reads who a sign-in is and its sites from Atlassian's answers", () => {
    expect(parseSites(text([POLYGON, { id: 1 }]))).toEqual([POLYGON]);
    expect(parseUser(text(people.coinme!.user))).toEqual({ accountId: "acc-2", email: "taylan@coinme.com", name: "Taylan" });
    expect(label({ id: "a", email: "x@y", sites: [POLYGON, COINME], addedAt: "" })).toBe("x@y · polygon.atlassian.net, coinme.atlassian.net");
  });

  it("keeps each account, sends a call to the account reaching its site, and survives a restart", async () => {
    const dir = tmp();
    const { calls, connector } = fake();
    const a = new Accounts(dir, connector);
    await a.add(token("polygon"));
    await a.add(token("coinme"));
    expect(a.list().map((x) => x.email).sort()).toEqual(["taylan@coinme.com", "taylan@polygon.technology"]);
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777, f).toBe(0o600);

    expect(answer(await a.call("getJiraIssue", { cloudId: "coinme.atlassian.net", issueIdOrKey: "OPS-1" }))).toContain('"ok":"coinme"');
    expect(answer(await a.call("createJiraIssue", { cloudId: POLYGON.id, projectKey: "PT" }))).toContain('"ok":"polygon"');
    expect(answer(await a.call("fetch", { id: `ari:cloud:confluence:${COINME.id}:page/1` }))).toContain('"ok":"coinme"');
    await expect(a.call("getJiraIssue", { cloudId: "globex.atlassian.net" })).rejects.toThrow(RouteError);
    await expect(a.call("getJiraIssue", { cloudId: "globex.atlassian.net" })).rejects.toThrow(/polygon\.atlassian\.net, coinme\.atlassian\.net|coinme\.atlassian\.net, polygon\.atlassian\.net/);

    // No site named: reads go to every account under each one's name; writes must say which.
    const both = answer(await a.call("search", { query: "wallet" }));
    expect(both).toMatch(/Account: taylan@polygon\.technology · polygon\.atlassian\.net/);
    expect(both).toMatch(/Account: taylan@coinme\.com · coinme\.atlassian\.net/);
    await expect(a.call("editJiraIssue", { issueIdOrKey: "PT-1" })).rejects.toThrow(/pass cloudId/);

    const again = new Accounts(dir, connector);
    expect(again.list()).toHaveLength(2);
    calls.length = 0;
    await again.call("getJiraIssue", { cloudId: "polygon.atlassian.net" });
    expect(calls.filter((c) => c.name === "getJiraIssue").map((c) => c.token)).toEqual(["polygon"]);
  });

  it("replaces an account when the same person signs in again, and forgets a removed one", async () => {
    const dir = tmp();
    const { connector } = fake();
    const a = new Accounts(dir, connector);
    const first = await a.add(token("polygon"));
    const second = await a.add(token("polygon2"));
    expect(second.id).toBe(first.id);
    expect(a.list()).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, `${first.id}.json`), "utf8")).access_token).toBe("polygon2");
    expect(answer(await a.call("getJiraIssue", { issueIdOrKey: "PT-1" }))).toContain('"ok":"polygon2"');

    expect(await a.remove(first.id)).toBe(true);
    expect(a.list()).toEqual([]);
    expect(existsSync(join(dir, `${first.id}.json`))).toBe(false);
    await expect(a.call("getJiraIssue", { issueIdOrKey: "PT-1" })).rejects.toThrow(/no Atlassian account/);
  });
});
