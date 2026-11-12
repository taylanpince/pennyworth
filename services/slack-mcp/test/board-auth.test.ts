import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BoardAuth } from "../src/board-auth.js";
import { TokenStore } from "../src/tokens.js";
test("board sign-in uses PKCE, consumes state and installs tokens into the active store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-auth-"));
  try {
    const store = new TokenStore(join(dir, "token.json"), "cid");
    let exchange: URLSearchParams | undefined;
    const auth = new BoardAuth("cid", store, (async (_url, opts) => {
      exchange = new URLSearchParams(String(opts?.body));
      return new Response(JSON.stringify({ ok: true, access_token: "test-access", refresh_token: "test-refresh", team: { id: "T123" } }));
    }) as typeof fetch);
    expect(auth.status()).toEqual({ configured: true, connected: false });
    const url = new URL(auth.start().url), state = url.searchParams.get("state")!;
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3118/callback");
    await expect(auth.finish("wrong", "code")).rejects.toThrow(/expired/);
    await auth.finish(state, "code");
    expect(exchange?.get("code_verifier")).toBeTruthy();
    expect(await store.accessToken()).toBe("test-access");
    expect(JSON.parse(readFileSync(join(dir, "token.json"), "utf8")).team_id).toBe("T123");
    await expect(auth.finish(state, "code")).rejects.toThrow(/already used/);
    expect(() => new BoardAuth("", store).start()).toThrow(/SLACK_CLIENT_ID/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("first-time client setup survives restart and cannot replace a configured client", () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-config-"));
  try {
    const path = join(dir, "client.json");
    const store = new TokenStore(join(dir, "token.json"), "");
    const auth = new BoardAuth("", store, fetch, path);
    auth.configure("12345.67890");
    expect(() => auth.configure("different")).toThrow(/already configured/);
    const restarted = new BoardAuth("", store, fetch, path);
    expect(restarted.status().configured).toBe(true);
    expect(new URL(restarted.start().url).searchParams.get("client_id")).toBe("12345.67890");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("token exchange reports safe actionable Slack errors without exposing response secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-error-"));
  try {
    for (const status of [200, 400]) {
      const store = new TokenStore(join(dir, "token.json"), "cid");
      const auth = new BoardAuth("cid", store, (async () => new Response(JSON.stringify({ ok: false, error: "bad_client_secret", access_token: "must-not-leak", error_description: "private-response" }), { status })) as typeof fetch);
      const state = new URL(auth.start().url).searchParams.get("state")!;
      await expect(auth.finish(state, "code")).rejects.toThrow("Slack returned bad_client_secret. Enable PKCE");
      expect(store.available()).toBe(false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
