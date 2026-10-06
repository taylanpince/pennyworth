import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gmailLink, loadAccounts } from "../src/accounts.js";

const file = (content: unknown) => {
  const p = join(mkdtempSync(join(tmpdir(), "gacc-")), "creds.json");
  writeFileSync(p, JSON.stringify(content));
  return p;
};

describe("google accounts", () => {
  it("reads the legacy single-account file", () => {
    const { primary, accounts } = loadAccounts(file({ client_id: "c", client_secret: "s", refresh_token: "r" }));
    expect(primary).toBe("default");
    expect(accounts.get("default")).toMatchObject({ client_id: "c", refresh_token: "r" });
  });

  it("reads multiple accounts sharing the client, honouring primary", () => {
    const { primary, accounts } = loadAccounts(
      file({ client_id: "c", client_secret: "s", primary: "me@work.com", accounts: { "me@side.io": { refresh_token: "r2" }, "me@work.com": { refresh_token: "r1" } } }),
    );
    expect(primary).toBe("me@work.com");
    expect([...accounts.keys()].sort()).toEqual(["me@side.io", "me@work.com"]);
    expect(accounts.get("me@side.io")).toMatchObject({ client_id: "c", client_secret: "s", refresh_token: "r2" });
  });

  it("falls back to the first account when primary is unknown, and fails when empty", () => {
    expect(loadAccounts(file({ client_id: "c", primary: "x@y.z", accounts: { "a@b.c": { refresh_token: "r" } } })).primary).toBe("a@b.c");
    expect(() => loadAccounts(file({ client_id: "c", accounts: {} }))).toThrow(/no Google accounts/);
  });

  it("links Gmail threads to the account they live in", () => {
    expect(gmailLink("1a07abbf", "me@side.io")).toBe("https://mail.google.com/mail/u/me%40side.io/#all/1a07abbf");
    expect(gmailLink("1a07abbf", "default")).toBe("https://mail.google.com/mail/u/0/#all/1a07abbf");
  });
});
