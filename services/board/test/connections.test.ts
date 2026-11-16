import { createApp } from "../src/app.js";
import { Store } from "../src/store.js";
import type { Paperclip } from "../src/paperclip.js";
import type { SlackAuth } from "../src/slack.js";
import pino from "pino";
import { test, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { request } from "node:http";

test("connection callbacks require the paired browser that started them, matching state, and one-time use", async () => {
  const store = new Store(":memory:");
  const first = store.pair(store.createPairing().code, "one")!, second = store.pair(store.createPairing().code, "two")!;
  let finishes = 0;
  const server = createApp({ paperclip: {} as Paperclip, store, log: pino({ level: "silent" }), staticDir: "/none", timezone: "UTC", mode: "lan", allowedHosts: ["localhost"], lan: { clients: ["127.0.0.0/8"], url: "http://localhost" }, slackAuth: { call: async (_method: string, path: string) => {
    if (path === "start") return { url: "https://slack.com/oauth/v2_user/authorize?state=our-state" };
    finishes++; return { connected: true };
  } } as unknown as SlackAuth });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  async function post(action: string, token: string, body: unknown, header = true) {
    return new Promise<number>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/connections/slack/${action}`, { method: "POST", headers: { host: "localhost", "content-type": "application/json", cookie: `pw_session=${token}`, ...(header ? { "x-pennyworth-board": "1" } : {}) } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
      req.on("error", reject); req.end(JSON.stringify(body));
    });
  }
  try {
    expect(await post("start", "", {})).toBe(401);
    expect(await post("start", first, {}, false)).toBe(403);
    expect(await post("start", first, {})).toBe(200);
    const callback = "http://localhost:3118/callback?state=our-state&code=test-code";
    expect(await post("finish", second, { callback })).toBe(400);
    expect(await post("finish", first, { callback: callback.replace("our-state", "wrong") })).toBe(400);
    expect(await post("finish", first, { callback: callback.replace("localhost", "evil.example") })).toBe(400);
    expect(finishes).toBe(0);
    expect(await post("finish", first, { callback })).toBe(200);
    expect(await post("finish", first, { callback })).toBe(400);
    expect(finishes).toBe(1);
  } finally { server.close(); store.close(); }
});
