import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowedTools, allowlist, truncateResult } from "../src/policy.js";
import { SCOPES, SignIn, SignInError } from "../src/signin.js";
import { JiraAuthError, TokenStore } from "../src/tokens.js";

const tokenFile = () => join(mkdtempSync(join(tmpdir(), "jira-mcp-")), "token.json");

/** A fake Atlassian token endpoint. */
function fakeToken(json: Record<string, unknown>, status = 200) {
  const calls: URLSearchParams[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    calls.push(new URLSearchParams(String(init?.body ?? "")));
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("SignIn", () => {
  it("asks for Jira scopes only, and refuses a grant beyond them", async () => {
    const store = new TokenStore(tokenFile());
    const { impl, calls } = fakeToken({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "read:jira-user read:jira-work write:jira-work offline_access" });
    const signIn = new SignIn("client-1", store, impl);
    const { url } = await signIn.start("http://127.0.0.1:3120/jira/callback");
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://auth.atlassian.com/authorize");
    expect(parsed.searchParams.get("audience")).toBe("api.atlassian.com");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("client_id")).toBe("client-1");
    expect(parsed.searchParams.get("scope")).toBe(SCOPES.join(" "));
    expect(parsed.searchParams.get("scope")).not.toMatch(/confluence|bitbucket|manage:jira-project/);
    const state = parsed.searchParams.get("state")!;
    await signIn.finish(state, "the-code");
    expect(calls[0]!.get("grant_type")).toBe("authorization_code");
    expect(calls[0]!.get("code")).toBe("the-code");
    expect(calls[0]!.get("code_verifier")).toHaveLength(64);

    const wider = new SignIn("client-1", store, fakeToken({ access_token: "at", scope: "read:jira-work write:jira-work manage:jira-project" }).impl);
    const again = await wider.start("http://127.0.0.1:3120/jira/callback");
    await expect(wider.finish(new URL(again.url).searchParams.get("state")!, "c")).rejects.toThrow(/manage:jira-project/);
  });

  it("refuses a non-loopback redirect and an unknown state", async () => {
    const signIn = new SignIn("client-1", new TokenStore(tokenFile()), fetch);
    await expect(signIn.start("https://example.com/callback")).rejects.toThrow(SignInError);
    await expect(signIn.finish("no-such-state", "code")).rejects.toThrow(/expired or was already used/);
  });

  it("requires a client id", async () => {
    const signIn = new SignIn("", new TokenStore(tokenFile()), fetch);
    await expect(signIn.start("http://127.0.0.1:3120/jira/callback")).rejects.toThrow(/ATLASSIAN_CLIENT_ID/);
  });
});

describe("tokens", () => {
  it("refreshes with the stored client and keeps the sign-in on a server error", async () => {
    const f = tokenFile();
    writeFileSync(f, JSON.stringify({ access_token: "old", refresh_token: "rt", expires_at: Date.now() - 1000, client_id: "client-1", token_endpoint: "https://auth.atlassian.com/oauth/token" }));
    let answered = 0;
    const impl = (async () => {
      answered++;
      return new Response(JSON.stringify({ access_token: "new", refresh_token: "rt2", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const store = new TokenStore(f, impl);
    expect(await store.accessToken()).toBe("new");
    expect(answered).toBe(1);

    const refusing = new TokenStore(f, fakeToken({ error: "invalid_grant" }, 400).impl);
    await expect(refusing.refresh()).rejects.toThrow(JiraAuthError);
    expect(refusing.status().state).toBe("expired");

    const broken = new TokenStore(f, fakeToken({ error: "temporarily_unavailable" }, 503).impl);
    await expect(broken.refresh()).rejects.toThrow();
    expect(broken.status().state).not.toBe("expired");
  });
});

describe("policy", () => {
  it("exposes only the allowlist", () => {
    const tools = [
      { name: "getIssue", description: "read" },
      { name: "createIssue", description: "write" },
      { name: "getConfluencePages", description: "other product" },
    ] as never[];
    expect(allowedTools(tools, allowlist("getIssue")).map((t) => t.name)).toEqual(["getIssue"]);
    expect(allowedTools(tools, allowlist(undefined)).map((t) => t.name)).toEqual([]);
    const exposed = allowedTools(tools, allowlist("getIssue"))[0]!;
    expect(exposed.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it("cuts long results with a note", () => {
    const out = truncateResult({ content: [{ type: "text", text: "a".repeat(250_000) }] } as never);
    expect(JSON.stringify(out).length).toBeLessThan(202_000);
    expect(JSON.stringify(out)).toMatch(/cut this answer/);
  });
});
