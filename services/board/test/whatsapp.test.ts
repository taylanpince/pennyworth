import { createApp } from "../src/app.js";
import { Store } from "../src/store.js";
import type { Paperclip } from "../src/paperclip.js";
import type { WhatsAppAuth } from "../src/whatsapp.js";
import pino from "pino";
import { test, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
test("WhatsApp selection requires a paired phone and validates chat IDs", async () => {
  const seen: unknown[] = [];
  const base = {
    paperclip: {} as Paperclip,
    store: new Store(":memory:"),
    log: pino({ level: "silent" }),
    staticDir: "/none",
    timezone: "UTC",
    whatsapp: {
      call: async (...a: unknown[]) => {
        seen.push(a);
        return { ok: true };
      },
    } as unknown as WhatsAppAuth,
  };
  const local = createApp({
    ...base,
    mode: "local",
    allowedHosts: ["localhost"],
  });
  const lan = createApp({
    ...base,
    mode: "lan",
    allowedHosts: ["localhost"],
    lan: { clients: ["127.0.0.0/8"], url: "http://localhost" },
  });
  for (const s of [local, lan])
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  async function put(s: typeof local, body: unknown) {
    return new Promise<number>((resolve, reject) => {
      const r = request(
        `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/whatsapp/chats`,
        {
          method: "PUT",
          headers: {
            host: "localhost",
            "content-type": "application/json",
            "x-pennyworth-board": "1",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      r.on("error", reject);
      r.end(JSON.stringify(body));
    });
  }
  try {
    expect(await put(lan, { ids: ["a"] })).toBe(401);
    expect(seen).toHaveLength(0);
    expect(await put(local, { ids: "all" })).toBe(400);
    expect(seen).toHaveLength(0);
    expect(await put(local, { ids: ["a"] })).toBe(200);
    expect(seen).toHaveLength(1);
  } finally {
    local.close();
    lan.close();
  }
});
