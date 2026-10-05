import type { GoogleClient } from "./google.js";

const CAL = "https://www.googleapis.com/calendar/v3";
const DRIVE = "https://www.googleapis.com/drive/v3";

interface GEvent {
  id: string;
  recurringEventId?: string;
  summary?: string;
  status?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email?: string; displayName?: string; self?: boolean; responseStatus?: string; resource?: boolean }[];
  location?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  attachments?: { fileId?: string; title?: string; fileUrl?: string }[];
  htmlLink?: string;
  organizer?: { email?: string; self?: boolean };
}

/** Event shape matching ops-mcp's meeting_match input. */
export interface NormalizedEvent {
  id: string;
  series_id?: string;
  title: string;
  start: string;
  end: string;
  timezone?: string;
  all_day: boolean;
  status?: string;
  attendees: { name?: string; email?: string; self?: boolean; response_status?: string }[];
  location?: string;
  meet_link?: string;
  attachments: { file_id?: string; title?: string; url?: string }[];
  html_link?: string;
}

export function normalizeEvent(e: GEvent): NormalizedEvent {
  const allDay = !e.start?.dateTime;
  const meet = e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
  return {
    id: e.id,
    series_id: e.recurringEventId,
    title: e.summary ?? "",
    start: e.start?.dateTime ?? `${e.start?.date}T00:00:00Z`,
    end: e.end?.dateTime ?? `${e.end?.date}T00:00:00Z`,
    timezone: e.start?.timeZone,
    all_day: allDay,
    status: e.status,
    attendees: (e.attendees ?? [])
      .filter((a) => !a.resource)
      .map((a) => ({ name: a.displayName, email: a.email, self: a.self, response_status: a.responseStatus })),
    location: e.location,
    meet_link: meet,
    attachments: (e.attachments ?? []).map((a) => ({ file_id: a.fileId, title: a.title, url: a.fileUrl })),
    html_link: e.htmlLink,
  };
}

const EVENT_FIELDS =
  "items(id,recurringEventId,summary,status,start,end,attendees(email,displayName,self,responseStatus,resource),location,hangoutLink,conferenceData(entryPoints(entryPointType,uri)),attachments(fileId,title,fileUrl),htmlLink),nextPageToken";

export class Workspace {
  constructor(
    private readonly g: GoogleClient,
    private readonly calendarId = "primary",
  ) {}

  async listEvents(start: string, end: string, query?: string, max = 100): Promise<NormalizedEvent[]> {
    const out: NormalizedEvent[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.g.get<{ items?: GEvent[]; nextPageToken?: string }>(`${CAL}/calendars/${encodeURIComponent(this.calendarId)}/events`, {
        timeMin: new Date(start).toISOString(),
        timeMax: new Date(end).toISOString(),
        singleEvents: true, // expand recurring series into occurrences (occurrence IDs)
        orderBy: "startTime",
        maxResults: Math.min(250, max),
        q: query,
        pageToken,
        fields: EVENT_FIELDS,
      });
      out.push(...(page.items ?? []).map(normalizeEvent));
      pageToken = page.nextPageToken;
    } while (pageToken && out.length < max);
    return out.slice(0, max);
  }

  async getEvent(id: string): Promise<NormalizedEvent> {
    const e = await this.g.get<GEvent>(`${CAL}/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(id)}`);
    return normalizeEvent(e);
  }

  async listFiles(q: string, max = 50): Promise<DriveFile[]> {
    const res = await this.g.get<{ files?: DriveFile[] }>(`${DRIVE}/files`, {
      q,
      pageSize: Math.min(100, max),
      orderBy: "modifiedTime desc",
      fields: "files(id,name,mimeType,modifiedTime,createdTime,version,webViewLink,size,owners(displayName,emailAddress))",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "allDrives",
    });
    return res.files ?? [];
  }

  recentFiles(since: string, max = 50): Promise<DriveFile[]> {
    return this.listFiles(`modifiedTime > '${new Date(since).toISOString()}' and trashed = false`, max);
  }

  /** Google Meet transcripts and Gemini notes modified since a time. */
  meetingDocuments(since: string, nameHints: string[], max = 50): Promise<DriveFile[]> {
    const names = nameHints.map((h) => `name contains '${escapeQ(h)}'`).join(" or ");
    return this.listFiles(
      `modifiedTime > '${new Date(since).toISOString()}' and trashed = false and mimeType = 'application/vnd.google-apps.document' and (${names})`,
      max,
    );
  }

  searchFiles(query: string, max = 25): Promise<DriveFile[]> {
    const q = escapeQ(query);
    return this.listFiles(`trashed = false and (name contains '${q}' or fullText contains '${q}')`, max);
  }

  async readFile(id: string, maxChars = 400_000): Promise<{ file: DriveFile; text: string; truncated: boolean }> {
    const file = await this.g.get<DriveFile>(`${DRIVE}/files/${encodeURIComponent(id)}`, {
      fields: "id,name,mimeType,modifiedTime,createdTime,version,webViewLink,size",
      supportsAllDrives: true,
    });
    let result: { text: string; truncated: boolean };
    if (file.mimeType === "application/vnd.google-apps.document") {
      result = await this.g.getText(`${DRIVE}/files/${encodeURIComponent(id)}/export`, { mimeType: "text/plain" });
    } else if (file.mimeType?.startsWith("text/") || file.mimeType === "application/json") {
      result = await this.g.getText(`${DRIVE}/files/${encodeURIComponent(id)}`, { alt: "media", supportsAllDrives: "true" });
    } else {
      throw new Error(`Unsupported file type ${file.mimeType}; only Google Docs and text files can be read`);
    }
    return { file, text: result.text.slice(0, maxChars), truncated: result.truncated || result.text.length > maxChars };
  }
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
  createdTime?: string;
  version?: string;
  webViewLink?: string;
  size?: string;
  owners?: { displayName?: string; emailAddress?: string }[];
}

export function escapeQ(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
