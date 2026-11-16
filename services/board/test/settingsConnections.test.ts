import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { connectionsView, type ConnectionInputs } from "../src/connections.js";
import { CloudflareAuth, GleanAuth } from "../src/mcpauth.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const base: ConnectionInputs = { googleEnabled: false, telegramEnabled: false, slackEnabled: false, whatsappEnabled: false, proxies: {} };
const byId = (i: ConnectionInputs) => Object.fromEntries(connectionsView(i).map((c) => [c.id, c]));

describe("Settings: the connections view", () => {
  it("shows every Google account, and the worst state wins", () => {
    const c = byId({
      ...base,
      googleEnabled: true,
      google: { accounts: [{ email: "work@x.com", primary: true, state: "ok", since: "" }, { email: "me@y.com", primary: false, state: "expired", since: "", detail: "invalid_grant" }] },
    }).google!;
    expect(c.state).toBe("attention");
    expect(c.accounts).toEqual([{ label: "work@x.com", state: "ok", primary: true }, { label: "me@y.com", state: "attention", detail: "invalid_grant" }]);
    expect(c.action).toEqual({ kind: "panel", panel: "google" });
  });

  it("tells a proxy that isn't set up from one that isn't answering or isn't signed in", () => {
    const v = byId({
      ...base,
      proxies: {
        glean: null,
        grafana: { state: "missing", configured: true, since: "t" },
        cloudflare: { state: "ok", configured: true, since: "t", account: "me@x.com" },
      },
    });
    expect(v.glean).toMatchObject({ state: "unknown", action: { kind: "connect", href: "/glean/connect" } });
    expect(v.grafana).toMatchObject({ state: "off", action: { kind: "connect", href: "/grafana/connect" } });
    expect(v.clickhouse).toMatchObject({ state: "unset", action: { kind: "setup" } });
    expect(v.cloudflare).toMatchObject({ state: "ok", accounts: [{ label: "me@x.com", state: "ok" }] });
  });

  it("shows the laptop's sign-ins from the runner's report, with every AWS account", () => {
    const v = byId({
      ...base,
      host: {
        at: "2026-11-16T10:00:00Z",
        checks: [
          { id: "gcloud", state: "expired", detail: "the Google Cloud session ended (16-hour reauth): run scripts/gcloud-auth.sh" },
          { id: "aws", state: "ok", accounts: [{ label: "prod (1)", state: "ok" }, { label: "dev (2)", state: "expired" }] },
          { id: "github", state: "ok", accounts: [{ label: "@octo", state: "ok" }] },
        ],
      },
    });
    expect(v.gcloud).toMatchObject({ group: "laptop", state: "attention", checkedAt: "2026-11-16T10:00:00Z", action: { kind: "command", command: "scripts/gcloud-auth.sh" } });
    expect(v.aws!.state).toBe("attention");
    expect(v.github).toMatchObject({ state: "ok", accounts: [{ label: "@octo", state: "ok" }] });
    expect(v.primer).toMatchObject({ state: "unknown", detail: "the runner didn't report it" });
    // Without compose.connections.yaml, Slack reconnects with the script.
    expect(v.slack!.action).toMatchObject({ kind: "command", command: "scripts/slack-auth.sh" });
  });

  it("only lists WhatsApp where it's set up", () => {
    expect(byId(base).whatsapp).toBeUndefined();
    expect(byId({ ...base, whatsappEnabled: true, whatsapp: { state: "connected" } }).whatsapp).toMatchObject({ state: "ok", action: { kind: "panel", panel: "whatsapp" } });
  });
});

describe("Settings: the connections routes", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const cloudflare = new CloudflareAuth("http://cf", "t", undefined, (async () => json({ state: "ok", configured: true, since: "t", account: "me@x.com" })) as unknown as typeof fetch);
  const glean = new GleanAuth("http://glean", "t", undefined, (async () => {
    throw new Error("down");
  }) as unknown as typeof fetch);

  it("lists connections, takes the runner's report on the internal API, and asks the runner to check again", async () => {
    const activity = {};
    const store = new Store(":memory:");
    const opts = { paperclip: {} as Paperclip, store, log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", cloudflare, glean, activity };
    const app = createApp({ ...opts, allowedHosts: ["localhost:3120"], mode: "local" });
    const internal = createApp({ ...opts, allowedHosts: ["board:3122"], mode: "internal", internalToken: "x".repeat(40) });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => internal.listen(0, "127.0.0.1", r));
    // fetch() always sends its own Host header, so requests go through node:http.
    const call = (s: typeof app, method: string, path: string, headers: Record<string, string>, body?: unknown) =>
      new Promise<{ status: number; json: () => Promise<any> }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: (s.address() as AddressInfo).port, method, path, headers }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: async () => JSON.parse(data) }));
        });
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    const headers = { host: "localhost:3120", "content-type": "application/json", "x-pennyworth-board": "1" };
    try {
      let r = await (await call(app, "GET", "/api/connections", headers)).json();
      expect(r.connections.find((c: { id: string }) => c.id === "cloudflare")).toMatchObject({ state: "ok", accounts: [{ label: "me@x.com" }] });
      expect(r.connections.find((c: { id: string }) => c.id === "glean")).toMatchObject({ state: "unknown" });
      expect(r.connections.find((c: { id: string }) => c.id === "gh")).toMatchObject({ state: "unknown", detail: "waiting for the runner's first check" });

      const auth = { host: "board:3122", authorization: `Bearer ${"x".repeat(40)}`, "content-type": "application/json" };
      const bad = await call(internal, "POST", "/internal/runner/connections", auth, { checks: [{ id: "gh", state: "ok", token: "leak" }] });
      expect(bad.status).toBe(400);
      const ok = await call(internal, "POST", "/internal/runner/connections", auth, { checks: [{ id: "gh", state: "ok", accounts: [{ label: "@octo", state: "ok" }] }] });
      expect(ok.status).toBe(200);
      r = await (await call(app, "GET", "/api/connections", headers)).json();
      expect(r.connections.find((c: { id: string }) => c.id === "gh")).toMatchObject({ state: "ok", accounts: [{ label: "@octo" }] });

      // Check now: the runner's next activity report is answered with a request to check.
      r = await (await call(app, "POST", "/api/connections/check", headers, {})).json();
      expect(r.checking).toBe(true);
      const report = { running: [], queued: [], recent: [], latest: [] };
      const first = await (await call(internal, "POST", "/internal/runner/activity", auth, report)).json();
      expect(first).toEqual({ ok: true, checkConnections: true });
      const second = await (await call(internal, "POST", "/internal/runner/activity", auth, report)).json();
      expect(second).toEqual({ ok: true });
    } finally {
      app.close();
      internal.close();
      store.close();
    }
  });
});

describe("Settings: before the runner's first check", () => {
  it("takes Slack's state from the board's own sign-in", () => {
    const v = Object.fromEntries(connectionsView({ ...base, slackEnabled: true, slack: { configured: true, connected: true } }).map((c) => [c.id, c]));
    expect(v.slack).toMatchObject({ state: "ok", action: { kind: "panel", panel: "slack" } });
    expect(v.slack!.detail).toBeUndefined();
  });
});
