import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

describe("internal listener (D-25)", () => {
  const TOKEN = "t".repeat(64);
  const store = new Store(":memory:");
  const issue = { id: "11111111-1111-1111-1111-111111111111", identifier: "PEN-1", title: "T", description: "", status: "todo", priority: "medium", assigneeUserId: "me-1", assigneeAgentId: null, assigneeAdapterOverrides: null, createdAt: "", updatedAt: "" };
  const pc = {
    me: async () => "me-1",
    agents: async () => [],
    labels: async () => [],
    company: async () => ({ issuePrefix: "PEN" }),
    issue: async () => issue,
  } as unknown as Paperclip;
  const app = createApp({ paperclip: pc, store, log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  // fetch() always sends its own Host header; the guard is tested with the names the bridge uses.
  const call = (method: string, path: string, body: unknown, headers: Record<string, string>) =>
    new Promise<{ status: number; json: () => Promise<unknown> }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: async () => JSON.parse(text) }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  afterAll(() => app.close());

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call("POST", path, body, { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers });

  it("needs the token and an allowed host", async () => {
    expect((await post("/internal/issues/PEN-1/schedule", { clear: true }, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post("/internal/issues/PEN-1/schedule", { clear: true }, { authorization: "" })).status).toBe(401);
    expect((await post("/internal/issues/PEN-1/schedule", { clear: true }, { host: "evil:3122" })).status).toBe(403);
  });

  it("serves only /internal/ routes: not the user's API or the page", async () => {
    expect((await post("/api/issues", { title: "x" })).status).toBe(404);
    expect((await call("GET", "/", undefined, { host: "board:3122", authorization: `Bearer ${TOKEN}` })).status).toBe(404);
  });

  it("schedules a move on the user's task, and rejects bad dates", async () => {
    const ok = await post("/internal/issues/PEN-1/schedule", { date: "2099-01-01" });
    expect(ok.status).toBe(400);
    const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const res = await post("/internal/issues/PEN-1/schedule", { date });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ identifier: "PEN-1", scheduled: { date, bucket: "today", position: "top" } });
    expect(store.schedules().get(issue.id)?.date).toBe(date);
  });
});
