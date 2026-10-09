import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { inNetworks, lanConfig, parseCidr } from "../src/config.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

describe("client networks", () => {
  it("matches IPv4 (and IPv4-mapped) addresses against CIDRs", () => {
    expect(parseCidr("192.168.7.0/24")).toBeDefined();
    expect(parseCidr("192.168.7.0")).toBeUndefined();
    expect(inNetworks("192.168.7.42", ["192.168.7.0/24"])).toBe(true);
    expect(inNetworks("::ffff:192.168.7.42", ["192.168.7.0/24"])).toBe(true);
    expect(inNetworks("192.168.8.1", ["192.168.7.0/24"])).toBe(false);
    expect(inNetworks("10.231.1.1", ["192.168.7.0/24"])).toBe(false);
    expect(inNetworks(undefined, ["0.0.0.0/0"])).toBe(false);
  });
});

describe("LAN config", () => {
  it("sends pairing links to BOARD_LAN_URL, or the first host when it's empty", () => {
    const env = { BOARD_LAN_CLIENTS: "192.168.7.0/24", BOARD_LAN_HOSTS: "pennyworth.local,bloomware.example.ts.net" };
    expect(lanConfig(env)?.url).toBe("http://pennyworth.local");
    expect(lanConfig({ ...env, BOARD_LAN_URL: "" })?.url).toBe("http://pennyworth.local");
    expect(lanConfig({ ...env, BOARD_LAN_URL: "https://bloomware.example.ts.net/" })?.url).toBe("https://bloomware.example.ts.net");
  });
});

describe("pairing", () => {
  it("spends a code once for a session token; tokens can be revoked", () => {
    const s = new Store(":memory:");
    const { code } = s.createPairing();
    const token = s.pair(code, "iPhone")!;
    expect(token).toMatch(/^[\w-]{40,}$/);
    expect(s.pair(code, "again")).toBeUndefined();
    expect(s.checkSession(token)).toBe(true);
    expect(s.checkSession("nope")).toBe(false);
    expect(s.checkSession(undefined)).toBe(false);
    const [d] = s.devices();
    expect(d?.device).toBe("iPhone");
    expect(s.revokeDevice(d!.id)).toBe(true);
    expect(s.checkSession(token)).toBe(false);
  });

  it("makes short codes without look-alikes, accepted however they're typed", () => {
    const s = new Store(":memory:");
    for (let i = 0; i < 50; i++) expect(s.createPairing().code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    const { code } = s.createPairing();
    expect(s.pair(` ${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `, "iPhone")).toBeDefined();
  });

  it("expires codes", () => {
    const s = new Store(":memory:");
    const { code } = s.createPairing(-1);
    expect(s.pair(code, "x")).toBeUndefined();
  });
});

describe("LAN listener", () => {
  const store = new Store(":memory:");
  const log = pino({ level: "silent" });
  const fakePaperclip = {} as Paperclip; // never reached without a session
  const lan = createApp({ paperclip: fakePaperclip, store, log, allowedHosts: ["pennyworth.local"], staticDir: "/nonexistent", timezone: "UTC", mode: "lan", lan: { clients: ["127.0.0.0/8"], url: "http://pennyworth.local" } });
  const outside = createApp({ paperclip: fakePaperclip, store, log, allowedHosts: ["pennyworth.local"], staticDir: "/nonexistent", timezone: "UTC", mode: "lan", lan: { clients: ["192.168.7.0/24"], url: "http://pennyworth.local" } });
  const local = createApp({ paperclip: fakePaperclip, store, log, allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", mode: "local", lan: { clients: ["127.0.0.0/8"], url: "http://pennyworth.local" } });
  let base = "";
  let outsideBase = "";
  let localBase = "";
  beforeAll(async () => {
    for (const s of [lan, outside, local]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(lan.address() as AddressInfo).port}`;
    outsideBase = `http://127.0.0.1:${(outside.address() as AddressInfo).port}`;
    localBase = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    for (const s of [lan, outside, local]) s.close();
  });
  const H = { host: "pennyworth.local", "content-type": "application/json", "x-pennyworth-board": "1", origin: "http://pennyworth.local" };
  // fetch() refuses to set Host, so use node:http.
  const req = async (url: string, method: string, headers: Record<string, string>, body?: unknown) => {
    const { request } = await import("node:http");
    return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const r = request(url, { method, headers }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
      });
      r.on("error", reject);
      r.end(body ? JSON.stringify(body) : undefined);
    });
  };

  it("refuses clients outside the home network, even for the page", async () => {
    expect((await req(`${outsideBase}/`, "GET", { host: "pennyworth.local" })).status).toBe(403);
  });

  it("asks unpaired devices to pair and never reaches Paperclip", async () => {
    const r = await req(`${base}/api/board`, "GET", { host: "pennyworth.local" });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body).error).toBe("pair");
    expect(JSON.parse((await req(`${base}/api/session`, "GET", { host: "pennyworth.local" })).body)).toMatchObject({ mode: "lan", paired: false });
  });

  it("only makes pairing links and lists devices on the laptop", async () => {
    expect((await req(`${base}/api/pairing`, "POST", H, {})).status).toBe(403);
    expect((await req(`${base}/api/devices`, "GET", { host: "pennyworth.local" })).status).toBe(403);
    const made = await req(`${localBase}/api/pairing`, "POST", { ...H, host: "localhost:3120", origin: "http://localhost:3120" }, {});
    expect(made.status).toBe(200);
    expect(JSON.parse(made.body).url).toMatch(/^http:\/\/pennyworth\.local\/#\/pair\/[A-Z2-9]{8}$/);
  });

  it("pairs with a valid link (once) and then lets the session in", async () => {
    expect((await req(`${base}/api/pair`, "POST", H, { code: "x".repeat(24) })).status).toBe(403);
    const code = new URL(JSON.parse((await req(`${localBase}/api/pairing`, "POST", { ...H, host: "localhost:3120", origin: "http://localhost:3120" }, {})).body).url).hash.split("/").pop()!;
    // A cross-site page can't spend it.
    expect((await req(`${base}/api/pair`, "POST", { ...H, origin: "http://evil.example" }, { code })).status).toBe(403);
    const paired = await req(`${base}/api/pair`, "POST", H, { code, device: "Test phone" });
    expect(paired.status).toBe(200);
    const cookie = String(paired.headers["set-cookie"]);
    expect(cookie).toMatch(/^pw_session=[\w-]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=/);
    expect((await req(`${base}/api/pair`, "POST", H, { code })).status).toBe(403);
    const session = await req(`${base}/api/session`, "GET", { host: "pennyworth.local", cookie: cookie.split(";")[0]! });
    expect(JSON.parse(session.body).paired).toBe(true);
  });
});
