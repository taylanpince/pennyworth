import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { GoogleAuth, loopbackPort } from "../src/google.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("loopback hosts", () => {
  it("allows reconnecting only on the laptop's loopback address", () => {
    expect(loopbackPort("127.0.0.1:3120")).toBe(3120);
    expect(loopbackPort("LOCALHOST:3120")).toBe(3120);
    expect(loopbackPort("pennyworth.local")).toBeUndefined();
    expect(loopbackPort("bloomware.example.ts.net:3120")).toBeUndefined();
    expect(loopbackPort(undefined)).toBeUndefined();
  });
});

describe("Google sign-in state", () => {
  it("caches for a minute, and gives up quietly when the sidecar can't be asked", async () => {
    let calls = 0;
    let up = true;
    const g = new GoogleAuth("http://google", "t", undefined, (async (_u: string | URL, init?: RequestInit) => {
      calls++;
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer t");
      if (!up) throw new Error("ECONNREFUSED");
      return json({ accounts: [{ email: "me@work.com", primary: true, state: "expired", since: "2026-10-12T20:35:54Z" }] });
    }) as typeof fetch);
    expect((await g.status())?.accounts[0]?.state).toBe("expired");
    await g.status();
    expect(calls).toBe(1);
    up = false;
    expect(await g.status(0)).toBeUndefined();
  });
});

describe("reconnect routes", () => {
  const seen: { path: string; body: unknown }[] = [];
  const google = new GoogleAuth("http://google", "t", undefined, (async (u: string | URL, init?: RequestInit) => {
    const path = new URL(String(u)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ path, body });
    if (path === "/auth/start") return json({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=s" });
    if (path === "/auth/finish") return body.code === "good" ? json({ email: "me@work.com" }) : json({ error: "you signed in as <b>x@y.z</b>, not me@work.com; nothing changed" }, 400);
    return json({}, 404);
  }) as typeof fetch);
  const store = new Store(":memory:");
  const base = { paperclip: {} as Paperclip, store, log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", google };
  const local = createApp({ ...base, allowedHosts: ["localhost:3120", "127.0.0.1:3120", "bloomware.example.ts.net"], mode: "local" });
  const lan = createApp({ ...base, allowedHosts: ["pennyworth.local"], mode: "lan", lan: { clients: ["127.0.0.0/8"], url: "http://pennyworth.local" } });
  let localBase = "";
  let lanBase = "";
  beforeAll(async () => {
    for (const s of [local, lan]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    localBase = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
    lanBase = `http://127.0.0.1:${(lan.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    for (const s of [local, lan]) s.close();
  });
  const get = async (url: string, host: string) => {
    const { request } = await import("node:http");
    return new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
      const r = request(url, { method: "GET", headers: { host } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, location: res.headers.location, body: data }));
      });
      r.on("error", reject);
      r.end();
    });
  };

  it("sends the laptop to Google with a callback on the address it came from", async () => {
    const r = await get(`${localBase}/google/connect?account=me%40work.com`, "127.0.0.1:3120");
    expect(r.status).toBe(302);
    expect(r.location).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(seen.at(-1)).toEqual({ path: "/auth/start", body: { account: "me@work.com", redirect_uri: "http://127.0.0.1:3120/google/callback" } });
  });

  it("refuses away from the laptop's loopback address", async () => {
    expect((await get(`${localBase}/google/connect?account=me%40work.com`, "bloomware.example.ts.net")).status).toBe(403);
    expect((await get(`${lanBase}/google/connect?account=me%40work.com`, "pennyworth.local")).status).toBe(403);
    expect((await get(`${localBase}/google/connect`, "evil.example")).status).toBe(403);
  });

  it("finishes the sign-in and returns to the board, or explains (escaped) why not", async () => {
    const ok = await get(`${localBase}/google/callback?state=s&code=good`, "127.0.0.1:3120");
    expect(ok).toMatchObject({ status: 302, location: "/" });
    const bad = await get(`${localBase}/google/callback?state=s&code=bad`, "127.0.0.1:3120");
    expect(bad.status).toBe(400);
    expect(bad.body).toContain("signed in as &#60;b&#62;x@y.z");
    expect(bad.body).not.toContain("<b>");
    const denied = await get(`${localBase}/google/callback?state=s&error=access_denied`, "127.0.0.1:3120");
    expect(denied.status).toBe(400);
    expect(denied.body).toContain("access_denied");
  });
});
