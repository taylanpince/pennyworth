import { describe, expect, it } from "vitest";
import { SCOPES } from "../src/google.js";
import { escapeQ, normalizeEvent } from "../src/workspace.js";

describe("google-workspace-mcp", () => {
  it("requests read-only scopes only", () => {
    for (const s of SCOPES) expect(s).toMatch(/\.readonly$/);
  });

  it("normalizes a recurring event occurrence for ops-mcp", () => {
    const e = normalizeEvent({
      id: "abc_20261004T120000Z",
      recurringEventId: "abc",
      summary: "OMS <> Privy Integration",
      start: { dateTime: "2026-10-04T14:00:00+02:00", timeZone: "Europe/Madrid" },
      end: { dateTime: "2026-10-04T14:30:00+02:00", timeZone: "Europe/Madrid" },
      attendees: [
        { email: "alice@x.com", displayName: "Alice" },
        { email: "room@resource.calendar.google.com", resource: true },
        { email: "me@x.com", self: true, responseStatus: "accepted" },
      ],
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      attachments: [{ fileId: "f1", title: "Transcript", fileUrl: "https://docs.google.com/document/d/f1" }],
    });
    expect(e).toMatchObject({
      id: "abc_20261004T120000Z",
      series_id: "abc",
      all_day: false,
      meet_link: "https://meet.google.com/abc-defg-hij",
      attachments: [{ file_id: "f1", title: "Transcript", url: "https://docs.google.com/document/d/f1" }],
    });
    expect(e.attendees).toHaveLength(2);
  });

  it("escapes Drive query strings", () => {
    expect(escapeQ("O'Brien \\ notes")).toBe("O\\'Brien \\\\ notes");
  });
});
