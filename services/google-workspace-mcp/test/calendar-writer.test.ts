import { test, expect } from "vitest";
import { CalendarWriter } from "../src/calendar-writer.js";
const event = {
  request_id: "MAN-1-dinner",
  summary: "Family dinner",
  start: { dateTime: "2026-11-12T19:00:00+01:00" },
  end: { dateTime: "2026-11-12T20:00:00+01:00" },
};
test("fixed calendar, no guest injection, deterministic retry and request conflict", async () => {
  let stored: Record<string, unknown> | undefined;
  const calls: string[] = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url).includes("oauth2"))
      return Response.json({ access_token: "test" });
    if (init?.method === "POST") {
      if (stored) return Response.json({}, { status: 409 });
      stored = JSON.parse(init.body as string);
      return Response.json({
        id: stored!.id,
        htmlLink: "https://calendar.google.com/test",
      });
    }
    return Response.json(stored);
  }) as typeof fetch;
  const w = new CalendarWriter(
    "family@example.com",
    { client_id: "id", refresh_token: "r" },
    fetcher,
  );
  await expect(w.create({ ...event, calendarId: "work" })).rejects.toThrow();
  await expect(
    w.create({ ...event, attendees: [{ email: "x@example.com" }] }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(0);
  expect((await w.create(event)).created).toBe(true);
  expect((await w.create(event)).created).toBe(false);
  expect(
    calls
      .filter((c) => c.includes("/calendars/"))
      .every((c) => c.includes("family%40example.com")),
  ).toBe(true);
  await expect(w.create({ ...event, summary: "Different" })).rejects.toThrow(
    "different event",
  );
  await expect(w.create({ ...event, end: event.start })).rejects.toThrow();
});
