import { describe, expect, it } from "vitest";
import { SCOPES } from "../src/google.js";
import { docIdFrom, docsBodyToMarkdown, escapeQ, messageText, normalizeEvent } from "../src/workspace.js";

describe("google-workspace-mcp", () => {
  it("requests read-only scopes only", () => {
    for (const s of SCOPES) expect(s).toMatch(/\.readonly$/);
  });

  it("normalizes a recurring event occurrence for ops-mcp", () => {
    const e = normalizeEvent({
      id: "abc_20261004T120000Z",
      recurringEventId: "abc",
      summary: "OMS <> Nimbus Integration",
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

  it("parses doc URLs with tabs and renders Docs bodies as markdown", () => {
    expect(docIdFrom("https://docs.google.com/document/d/1XoSua5F_x-Y/edit?tab=t.0")).toEqual({ id: "1XoSua5F_x-Y", tab: "t.0" });
    expect(docIdFrom("1XoSua5F")).toEqual({ id: "1XoSua5F", tab: undefined });
    const md = docsBodyToMarkdown([
      { paragraph: { paragraphStyle: { namedStyleType: "HEADING_2" }, elements: [{ textRun: { content: "Agenda 2026-10-05\n" } }] } },
      { paragraph: { bullet: { nestingLevel: 0 }, elements: [{ textRun: { content: "Mainnet checks\n" } }] } },
      { paragraph: { bullet: { nestingLevel: 1 }, elements: [{ textRun: { content: "Carlos\n" } }] } },
      { table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: "Owner\n" } }] } }] }, { content: [{ paragraph: { elements: [{ textRun: { content: "Item\n" } }] } }] }] }] } },
    ]);
    expect(md).toBe("## Agenda 2026-10-05\n- Mainnet checks\n  - Carlos\n| Owner | Item |");
  });

  it("extracts Gmail message text (plain preferred, HTML fallback)", () => {
    const enc = (s: string) => Buffer.from(s).toString("base64url");
    expect(messageText({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: enc("<p>Hi</p>") } }, { mimeType: "text/plain", body: { data: enc("Hi plain") } }] })).toBe("Hi plain");
    expect(messageText({ mimeType: "text/html", body: { data: enc("<p>Hello&nbsp;<b>there</b></p><style>x{}</style>") } }).trim()).toBe("Hello there");
  });

  it("escapes Drive query strings", () => {
    expect(escapeQ("O'Brien \\ notes")).toBe("O\\'Brien \\\\ notes");
  });
});
