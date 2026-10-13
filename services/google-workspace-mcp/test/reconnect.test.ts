import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MultiWorkspace } from "../src/accounts.js";
import { SCOPES } from "../src/google.js";
import { Reconnect } from "../src/reconnect.js";

const credsFile = () => {
  const p = join(mkdtempSync(join(tmpdir(), "grec-")), "creds.json");
  writeFileSync(
    p,
    JSON.stringify({ client_id: "cid", client_secret: "sec", primary: "me@work.com", accounts: { "me@work.com": { refresh_token: "old" }, "me@side.io": { refresh_token: "side" } } }),
  );
  return p;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Google's token and profile endpoints, answering as `email`. */
function google(email: string, scope = SCOPES.join(" ")) {
  const calls: { url: string; body?: string }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? String(init.body) : undefined });
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) return json({ refresh_token: "new", access_token: "at", scope });
    return json({ emailAddress: email });
  }) as typeof fetch;
  return { impl, calls };
}

const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

describe("sign-in state", () => {
  it("marks a refused refresh token as expired, keeping when it started; a network failure is only an error", async () => {
    const path = credsFile();
    let answer: () => Promise<Response> = async () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
    const ws = new MultiWorkspace(path, "primary", (async () => answer()) as typeof fetch);
    expect(ws.authStatus().map((a) => a.state)).toEqual(["unknown", "unknown"]);
    const [first] = await ws.checkAuth();
    expect(first).toMatchObject({ email: "me@work.com", primary: true, state: "expired" });
    expect(first!.detail).toMatch(/invalid_grant/);
    const [again] = await ws.checkAuth();
    expect(again!.since).toBe(first!.since);
    answer = async () => {
      throw new Error("getaddrinfo EAI_AGAIN oauth2.googleapis.com");
    };
    expect((await ws.checkAuth())[0]).toMatchObject({ state: "error" });
    answer = async () => json({ access_token: "at", expires_in: 3600 });
    expect((await ws.checkAuth()).map((a) => a.state)).toEqual(["ok", "ok"]);
  });
});

describe("reconnect from the board", () => {
  const redirect = "http://127.0.0.1:3120/google/callback";

  it("asks Google for the read-only scopes, for that account, with PKCE", () => {
    const { url } = new Reconnect(credsFile()).start("me@work.com", redirect);
    const q = new URL(url).searchParams;
    expect(q.get("client_id")).toBe("cid");
    expect(q.get("redirect_uri")).toBe(redirect);
    expect(q.get("scope")).toBe(SCOPES.join(" "));
    expect(q.get("login_hint")).toBe("me@work.com");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("access_type")).toBe("offline");
  });

  it("refuses unknown accounts and non-loopback redirects", () => {
    const r = new Reconnect(credsFile());
    expect(() => r.start("stranger@x.io", redirect)).toThrow(/isn't a connected account/);
    expect(() => r.start("me@work.com", "https://evil.example/cb")).toThrow(/loopback/);
    expect(() => r.start("me@work.com", "http://pennyworth.local/google/callback")).toThrow(/loopback/);
  });

  it("stores the new refresh token for that account only, keeping the primary and the other accounts", async () => {
    const path = credsFile();
    const g = google("me@work.com");
    const r = new Reconnect(path, g.impl);
    const { url } = r.start("me@work.com", redirect);
    expect(await r.finish(stateOf(url), "code-1")).toEqual({ email: "me@work.com" });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.primary).toBe("me@work.com");
    expect(saved.accounts["me@work.com"]).toMatchObject({ refresh_token: "new" });
    expect(saved.accounts["me@side.io"]).toEqual({ refresh_token: "side" });
    const exchange = new URLSearchParams(g.calls[0]!.body);
    expect(exchange.get("code_verifier")).toBeTruthy();
    expect(exchange.get("redirect_uri")).toBe(redirect);
  });

  it("changes nothing when someone else signs in, or more than read-only scopes come back", async () => {
    const path = credsFile();
    const before = readFileSync(path, "utf8");
    const other = new Reconnect(path, google("me@side.io").impl);
    await expect(other.finish(stateOf(other.start("me@work.com", redirect).url), "c")).rejects.toThrow(/signed in as me@side.io, not me@work.com/);
    const wide = new Reconnect(path, google("me@work.com", `${SCOPES.join(" ")} https://www.googleapis.com/auth/gmail.send`).impl);
    await expect(wide.finish(stateOf(wide.start("me@work.com", redirect).url), "c")).rejects.toThrow(/unexpected scopes/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("spends each state once, and expires it", async () => {
    const path = credsFile();
    const r = new Reconnect(path, google("me@work.com").impl);
    const state = stateOf(r.start("me@work.com", redirect).url);
    await r.finish(state, "c");
    await expect(r.finish(state, "c")).rejects.toThrow(/expired or was already used/);
    const quick = new Reconnect(path, google("me@work.com").impl, -1);
    await expect(quick.finish(stateOf(quick.start("me@work.com", redirect).url), "c")).rejects.toThrow(/expired/);
    await expect(r.finish("made-up-state-value", "c")).rejects.toThrow(/expired or was already used/);
  });
});
