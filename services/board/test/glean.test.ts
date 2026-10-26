import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { GleanAuth, GrafanaAuth } from "../src/mcpauth.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Glean sign-in state", () => {
  it("caches for a minute, and gives up quietly when glean-mcp can't be asked", async () => {
    let calls = 0;
    let up = true;
    const g = new GleanAuth("http://glean", "t", undefined, (async (_u: string | URL, init?: RequestInit) => {
      calls++;
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer t");
      if (!up) throw new Error("ECONNREFUSED");
      return json({ configured: true, state: "expired", since: "2026-10-15T10:00:00Z" });
    }) as typeof fetch);
    expect((await g.status())?.state).toBe("expired");
    await g.status();
    expect(calls).toBe(1);
    up = false;
    expect(await g.status(0)).toBeUndefined();
  });
});

describe("Glean sign-in routes", () => {
  const seen: { path: string; body: unknown }[] = [];
  const glean = new GleanAuth("http://glean", "t", undefined, (async (u: string | URL, init?: RequestInit) => {
    const path = new URL(String(u)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ path, body });
    if (path === "/auth/start") return json({ url: "https://acme.glean.com/oauth/authorize?state=s" });
    if (path === "/auth/finish") return body.code === "good" ? json({ ok: true }) : json({ error: "Glean refused the sign-in: <i>invalid_grant</i>" }, 400);
    return json({}, 404);
  }) as typeof fetch);
  const store = new Store(":memory:");
  const base = { paperclip: {} as Paperclip, store, log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", glean };
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

  it("sends the laptop to Glean with a callback on the address it came from", async () => {
    const r = await get(`${localBase}/glean/connect`, "localhost:3120");
    expect(r.status).toBe(302);
    expect(r.location).toMatch(/^https:\/\/acme\.glean\.com\//);
    expect(seen.at(-1)).toEqual({ path: "/auth/start", body: { redirect_uri: "http://localhost:3120/callback" } });
  });

  it("refuses away from the laptop's loopback address", async () => {
    expect((await get(`${localBase}/glean/connect`, "bloomware.example.ts.net")).status).toBe(403);
    expect((await get(`${lanBase}/glean/connect`, "pennyworth.local")).status).toBe(403);
    expect((await get(`${localBase}/glean/connect`, "evil.example")).status).toBe(403);
  });

  it("finishes the sign-in and returns to the board, or explains (escaped) why not", async () => {
    expect(await get(`${localBase}/callback?state=s&code=good`, "127.0.0.1:3120")).toMatchObject({ status: 302, location: "/" });
    const bad = await get(`${localBase}/callback?state=s&code=bad`, "127.0.0.1:3120");
    expect(bad.status).toBe(400);
    expect(bad.body).toContain("invalid_grant");
    expect(bad.body).not.toContain("<i>");
    const denied = await get(`${localBase}/callback?state=s&error=access_denied`, "127.0.0.1:3120");
    expect(denied.status).toBe(400);
    expect(denied.body).toContain("access_denied");
  });
});

describe("Grafana sign-in routes", () => {
  const seen: { path: string; body: unknown }[] = [];
  const grafana = new GrafanaAuth("http://grafana", "t", undefined, (async (u: string | URL, init?: RequestInit) => {
    const path = new URL(String(u)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ path, body });
    if (path === "/auth/start") return json({ url: "https://mcp.grafana.com/mcp/oauth/authorize?grafana_url=x&state=s" });
    if (path === "/auth/finish") return body.code === "good" ? json({ ok: true }) : json({ error: "Grafana refused the sign-in: invalid_grant" }, 400);
    return json({}, 404);
  }) as typeof fetch);
  // Grafana alone: Glean's bare /callback must not reach Grafana.
  const app = createApp({ paperclip: {} as Paperclip, store: new Store(":memory:"), log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", grafana, allowedHosts: ["localhost:3120", "127.0.0.1:3120"], mode: "local" });
  let base = "";
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  });
  afterAll(() => void app.close());
  const get = async (path: string) => {
    const { request } = await import("node:http");
    return new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
      const r = request(`${base}${path}`, { method: "GET", headers: { host: "localhost:3120" } }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, location: res.headers.location, body: data }));
      });
      r.on("error", reject);
      r.end();
    });
  };

  it("sends the laptop to Grafana with its own callback, and finishes there", async () => {
    const r = await get("/grafana/connect");
    expect(r).toMatchObject({ status: 302, location: expect.stringMatching(/^https:\/\/mcp\.grafana\.com\//) });
    expect(seen.at(-1)).toEqual({ path: "/auth/start", body: { redirect_uri: "http://localhost:3120/grafana/callback" } });
    expect(await get("/grafana/callback?state=s&code=good")).toMatchObject({ status: 302, location: "/" });
    expect(seen.at(-1)).toEqual({ path: "/auth/finish", body: { state: "s", code: "good" } });
    const bad = await get("/grafana/callback?state=s&code=bad");
    expect(bad.status).toBe(400);
    expect(bad.body).toContain("connect Grafana: Grafana refused the sign-in");
  });

  it("leaves Glean's /callback alone when Glean isn't set up", async () => {
    const before = seen.length;
    expect((await get("/callback?state=s&code=good")).status).toBe(404);
    expect(seen.length).toBe(before);
  });
});
