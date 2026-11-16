import { describe, expect, it } from "vitest";
import { RunnerPollSchema, SignIns } from "../src/signins.js";

let n = 0;
const ids = () => (++n).toString(16).padStart(24, "0");

describe("sign-ins relayed to the runner (D-66)", () => {
  it("hands the runner a start, shows what it reports, and passes the answer on once", async () => {
    const s = new SignIns(ids);
    expect(s.runnerOnline()).toBe(false);
    const started = s.start("gcloud");
    expect(started).toMatchObject({ provider: "gcloud", status: "starting" });
    expect(await s.poll([], 0)).toEqual([{ session: started.id, kind: "start", provider: "gcloud" }]);
    expect(s.runnerOnline()).toBe(true);

    await s.poll([{ session: started.id, status: "waiting", url: "https://accounts.google.com/o/oauth2/auth?x=1", prompt: { label: "Code", secret: false } }], 0);
    expect(s.get("gcloud")).toMatchObject({ status: "waiting", url: "https://accounts.google.com/o/oauth2/auth?x=1", prompt: { label: "Code" } });

    const after = s.input("gcloud", "4/0abc");
    expect(after.prompt).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain("4/0abc");
    expect(await s.poll([], 0)).toEqual([{ session: started.id, kind: "input", text: "4/0abc" }]);
    // Delivered once: the answer is gone from the board.
    expect(await s.poll([], 0)).toEqual([]);
    expect(() => s.input("gcloud", "again")).toThrow(/isn't waiting/);

    await s.poll([{ session: started.id, status: "done", message: "Signed in." }], 0);
    expect(s.get("gcloud")).toMatchObject({ status: "done", message: "Signed in." });
    expect(s.get("gcloud")!.url).toBeUndefined();
  });

  it("wakes a waiting poll as soon as there's a command", async () => {
    const s = new SignIns(ids);
    const waiting = s.poll([], 5_000);
    const t = Date.now();
    const started = s.start("aws");
    expect(await waiting).toEqual([{ session: started.id, kind: "start", provider: "aws" }]);
    expect(Date.now() - t).toBeLessThan(1_000);
  });

  it("cancels: a new start replaces the old one, and the runner hears both", async () => {
    const s = new SignIns(ids);
    const first = s.start("codex");
    const second = s.start("codex");
    expect(await s.poll([], 0)).toEqual([
      { session: first.id, kind: "start", provider: "codex" },
      { session: first.id, kind: "cancel" },
      { session: second.id, kind: "start", provider: "codex" },
    ]);
    // A late report about the replaced sign-in changes nothing.
    await s.poll([{ session: first.id, status: "waiting", code: "ABCD-1234" }], 0);
    expect(s.get("codex")).toMatchObject({ id: second.id, status: "starting" });
    expect(s.cancel("codex")).toMatchObject({ status: "cancelled" });
  });

  it("gives up a sign-in nobody finishes", async () => {
    const s = new SignIns(ids, 1_000);
    const started = s.start("claude", new Date(Date.now() - 5_000));
    expect(s.get("claude")).toMatchObject({ status: "failed" });
    expect(await s.poll([], 0)).toContainEqual({ session: started.id, kind: "cancel" });
  });

  it("only takes https links and plain codes from the runner", () => {
    const ok = { session: "a".repeat(24), status: "waiting" };
    expect(RunnerPollSchema.safeParse({ updates: [{ ...ok, url: "https://github.com/login/device", code: "ABCD-1234" }] }).success).toBe(true);
    expect(RunnerPollSchema.safeParse({ updates: [{ ...ok, url: "javascript:alert(1)" }] }).success).toBe(false);
    expect(RunnerPollSchema.safeParse({ updates: [{ ...ok, url: "http://evil.example/" }] }).success).toBe(false);
    expect(RunnerPollSchema.safeParse({ updates: [{ ...ok, code: "<script>" }] }).success).toBe(false);
    expect(RunnerPollSchema.safeParse({ updates: [{ ...ok, token: "sk-ant-oat01-x" }] }).success).toBe(false);
  });
});

describe("each report replaces what's shown", () => {
  it("drops the link, code and message a later report leaves out", async () => {
    const s = new SignIns(ids);
    const started = s.start("aws");
    await s.poll([{ session: started.id, status: "waiting", message: "Starting…" }], 0);
    await s.poll([{ session: started.id, status: "waiting", url: "https://d-1.awsapps.com/start/#/device", code: "ABCD-EFGH" }], 0);
    expect(s.get("aws")!.message).toBeUndefined();
    await s.poll([{ session: started.id, status: "waiting", message: "Checking…" }], 0);
    expect(s.get("aws")).toMatchObject({ id: started.id, provider: "aws", status: "waiting", message: "Checking…" });
    expect(s.get("aws")!.url).toBeUndefined();
  });
});
