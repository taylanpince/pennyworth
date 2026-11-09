import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readBackup } from "../src/backup.js";

const now = Date.parse("2026-11-09T12:00:00Z");
const file = (status: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), "backup-")), "backup.json");
  writeFileSync(f, typeof status === "string" ? status : JSON.stringify(status));
  return f;
};

describe("readBackup (D-58)", () => {
  it("never: the backup hasn't run, so there's a banner", () => {
    expect(readBackup("/nonexistent/backup.json", now)).toEqual({ state: "never", lastSuccess: null, stale: true });
  });

  it("missing: the timer runs but there's no repository to send to", () => {
    expect(readBackup(file({ state: "missing", at: "2026-11-09T11:00:00Z", lastSuccess: null, error: "no restic.env" }), now)).toMatchObject({ state: "missing", stale: true });
  });

  it("a recent success is fine, even after a failed run (the laptop was offline)", () => {
    expect(readBackup(file({ state: "ok", at: "2026-11-09T11:00:00Z", lastSuccess: "2026-11-09T11:00:00Z" }), now).stale).toBe(false);
    expect(readBackup(file({ state: "failed", at: "2026-11-09T11:30:00Z", lastSuccess: "2026-11-08T20:00:00Z", error: "dial tcp: no route" }), now)).toMatchObject({ state: "failed", stale: false });
  });

  it("no success in 26 hours is stale, with the last error", () => {
    expect(readBackup(file({ state: "failed", at: "2026-11-09T11:00:00Z", lastSuccess: "2026-11-08T09:00:00Z", error: "Fatal: wrong password" }), now)).toEqual({
      state: "failed",
      lastSuccess: "2026-11-08T09:00:00Z",
      error: "Fatal: wrong password",
      stale: true,
    });
  });

  it("an unreadable file is a failure, not a crash", () => {
    expect(readBackup(file("{not json"), now)).toMatchObject({ state: "failed", stale: true });
  });
});
