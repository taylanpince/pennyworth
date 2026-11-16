import { createHash } from "node:crypto";
import { z } from "zod";
import type { StoredCredentials } from "./google.js";
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.union([
  z.object({ date }).strict(),
  z.object({ dateTime: z.string().datetime({ offset: true }) }).strict(),
]);
export const EventInput = z
  .object({
    request_id: z.string().min(8).max(200),
    summary: z.string().min(1).max(300),
    description: z.string().max(8000).optional(),
    location: z.string().max(1000).optional(),
    start: time,
    end: time,
  })
  .strict()
  .superRefine((a, ctx) => {
    const start = "date" in a.start ? a.start.date : a.start.dateTime,
      end = "date" in a.end ? a.end.date : a.end.dateTime;
    if (
      "date" in a.start !== "date" in a.end ||
      !Number.isFinite(Date.parse(start)) ||
      Date.parse(end) <= Date.parse(start)
    )
      ctx.addIssue({
        code: "custom",
        message: "End must follow start; use matching date types",
      });
  });
/** Dedicated credential and one fixed calendar. No caller-supplied URLs, calendars, guests, updates or deletes. */
export class CalendarWriter {
  constructor(
    private readonly calendarId: string,
    private readonly creds: StoredCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!calendarId || calendarId === "primary")
      throw new Error("An explicit calendar ID is required");
  }
  async create(raw: unknown) {
    const a = EventInput.parse(raw),
      { request_id, ...event } = a;
    const id = createHash("sha256").update(request_id).digest("hex");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(event))
      .digest("hex");
    const tokenRes = await this.fetchImpl(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        body: new URLSearchParams({
          client_id: this.creds.client_id,
          client_secret: this.creds.client_secret ?? "",
          refresh_token: this.creds.refresh_token,
          grant_type: "refresh_token",
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!tokenRes.ok || !token.access_token)
      throw new Error("Calendar write consent is missing or expired");
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events`;
    const headers = {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json",
    };
    let res = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...event,
        id,
        extendedProperties: { private: { manorRequest: fingerprint } },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 409) {
      res = await this.fetchImpl(`${url}/${id}`, {
        headers,
        signal: AbortSignal.timeout(30000),
      });
      const existing = (await res.json()) as {
        id: string;
        htmlLink?: string;
        extendedProperties?: { private?: { manorRequest?: string } };
      };
      if (
        !res.ok ||
        existing.extendedProperties?.private?.manorRequest !== fingerprint
      )
        throw new Error("Request ID already used for a different event");
      return { id: existing.id, url: existing.htmlLink, created: false };
    }
    if (!res.ok) throw new Error(`Calendar creation failed (${res.status})`);
    const result = (await res.json()) as { id: string; htmlLink?: string };
    return { id: result.id, url: result.htmlLink, created: true };
  }
}
