import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { TelegramAuth } from "../src/telegram.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Telegram sign-in", () => {
  const seen: { path: string; body: unknown }[] = [];
  let state = "missing";
  const telegram = new TelegramAuth("http://telegram", "t", undefined, (async (u: string | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer t");
    const path = new URL(String(u)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ path, body });
    if (path === "/auth/status") return json({ state, configured: true, since: "2026-10-15T09:00:00Z" });
    if (path === "/auth/start") return json({ step: "code", login_id: "a".repeat(32), via_app: true });
    if (path === "/auth/code") return body.code === "12345" ? json({ step: "password", login_id: body.login_id }) : json({ error: "that code isn't right" }, 400);
    if (path === "/auth/password") {
      state = "ok";
      return json({ step: "done", account: { name: "Dana Whitfield", username: "dana" } });
    }
    return json({}, 404);
  }) as typeof fetch);
  const store = new Store(":memory:");
  const base = { paperclip: {} as Paperclip, store, log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", telegram };
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
  const post = async (url: string, host: string, body: unknown) => {
    const { request } = await import("node:http");
    const data = JSON.stringify(body);
    return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const r = request(url, { method: "POST", headers: { host, "content-type": "application/json", "content-length": Buffer.byteLength(data), "x-pennyworth-board": "1" } }, (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: out ? JSON.parse(out) : {} }));
      });
      r.on("error", reject);
      r.end(data);
    });
  };

  it("walks phone, code and password through to telegram-mcp, and refreshes the state when done", async () => {
    expect((await telegram.status())?.state).toBe("missing");
    const start = await post(`${localBase}/api/telegram/start`, "127.0.0.1:3120", { phone: "+34 600 000 000" });
    expect(start).toMatchObject({ status: 200, body: { step: "code", via_app: true } });
    const wrong = await post(`${localBase}/api/telegram/code`, "127.0.0.1:3120", { login_id: start.body.login_id, code: "00000" });
    expect(wrong).toMatchObject({ status: 400, body: { error: "that code isn't right" } });
    const code = await post(`${localBase}/api/telegram/code`, "localhost:3120", { login_id: start.body.login_id, code: "12345" });
    expect(code.body.step).toBe("password");
    const done = await post(`${localBase}/api/telegram/password`, "127.0.0.1:3120", { login_id: start.body.login_id, password: "hunter2" });
    expect(done.body).toMatchObject({ step: "done", account: { username: "dana" } });
    expect((await telegram.status())?.state).toBe("ok");
  });

  it("refuses away from the laptop's loopback address, and odd input", async () => {
    const before = seen.length;
    expect((await post(`${localBase}/api/telegram/start`, "bloomware.example.ts.net", { phone: "+34600000000" })).status).toBe(403);
    expect((await post(`${lanBase}/api/telegram/start`, "pennyworth.local", { phone: "+34600000000" })).status).toBe(403);
    expect((await post(`${localBase}/api/telegram/start`, "127.0.0.1:3120", { phone: "+34600000000", extra: 1 })).status).toBe(400);
    expect(seen.length).toBe(before);
  });
});
