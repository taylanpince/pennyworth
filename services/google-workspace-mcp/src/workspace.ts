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

  /**
   * Read a Google Doc with all its tabs (the Drive text export only returns the first tab).
   * Without tab_id: the tab list plus the content of the requested or first tab.
   */
  async readDoc(input: string, tabId?: string, maxChars = 200_000): Promise<{ id: string; title: string; tabs: { id: string; title: string; depth: number }[]; tab: { id: string; title: string; content: string; truncated: boolean } }> {
    const { id, tab: urlTab } = docIdFrom(input);
    let doc: { documentId: string; title: string; tabs?: DocsTab[] };
    try {
      doc = await this.g.get(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}`, { includeTabsContent: true });
    } catch (err) {
      // Docs API not enabled in the Cloud project: fall back to Drive's text export (first tab only).
      if (!/docs\.googleapis\.com|Docs API has not been used|SERVICE_DISABLED/.test(String(err))) throw err;
      const { file, text, truncated } = await this.readFile(id, maxChars);
      return {
        id,
        title: file.name,
        tabs: [{ id: "", title: "(tabs unavailable: enable the Google Docs API for full tab support)", depth: 0 }],
        tab: { id: "", title: "first tab (Drive export)", content: text, truncated },
      };
    }
    const tabs = flattenTabs(doc.tabs);
    const wanted = tabId ?? urlTab;
    const chosen = (wanted && tabs.find((t) => t.id === wanted || t.title.toLowerCase() === wanted.toLowerCase())) || tabs[0];
    const content = chosen ? docsBodyToMarkdown(chosen.tab.documentTab?.body?.content) : "";
    return {
      id: doc.documentId,
      title: doc.title,
      tabs: tabs.map(({ id, title, depth }) => ({ id, title, depth })),
      tab: { id: chosen?.id ?? "", title: chosen?.title ?? "", content: content.slice(0, maxChars), truncated: content.length > maxChars },
    };
  }

  /** Gmail search (Gmail query syntax). Returns message metadata, newest first. */
  async gmailSearch(query: string, max = 20): Promise<Record<string, unknown>[]> {
    const list = await this.g.get<{ messages?: { id: string; threadId: string }[] }>("https://gmail.googleapis.com/gmail/v1/users/me/messages", { q: query, maxResults: Math.min(50, max) });
    const out: Record<string, unknown>[] = [];
    for (const { id } of list.messages ?? []) {
      const full = await this.g.get<GmailMessage>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, { format: "metadata" });
      out.push({
        id: full.id,
        thread_id: full.threadId,
        from: header(full, "From"),
        to: header(full, "To"),
        cc: header(full, "Cc"),
        subject: header(full, "Subject"),
        date: full.internalDate ? new Date(Number(full.internalDate)).toISOString() : header(full, "Date"),
        labels: full.labelIds ?? [],
        snippet: full.snippet,
        link: `https://mail.google.com/mail/u/0/#all/${full.threadId}`,
      });
    }
    return out;
  }

  /** A whole thread as text, oldest first; message bodies truncated. */
  async gmailThread(id: string, maxCharsPerMessage = 6000): Promise<Record<string, unknown>> {
    const t = await this.g.get<{ id: string; messages?: GmailMessage[] }>(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(id)}`, { format: "full" });
    const profile = await this.g.get<{ emailAddress: string }>("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    return {
      thread_id: t.id,
      me: profile.emailAddress,
      link: `https://mail.google.com/mail/u/0/#all/${t.id}`,
      messages: (t.messages ?? []).map((m) => {
        const text = messageText(m.payload);
        return {
          id: m.id,
          from: header(m, "From"),
          to: header(m, "To"),
          cc: header(m, "Cc"),
          subject: header(m, "Subject"),
          date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : header(m, "Date"),
          labels: m.labelIds ?? [],
          from_me: (m.labelIds ?? []).includes("SENT"),
          attachments: attachments(m.payload),
          text: text.slice(0, maxCharsPerMessage),
          truncated: text.length > maxCharsPerMessage,
        };
      }),
    };
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

// ---------------------------------------------------------------- Gmail (read-only)

interface GmailPart { mimeType?: string; filename?: string; body?: { data?: string; size?: number }; parts?: GmailPart[]; headers?: { name: string; value: string }[] }
interface GmailMessage { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: GmailPart }

const header = (m: GmailMessage, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

const b64url = (data: string) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** Plain-text body of a message: text/plain preferred, else HTML with tags stripped. */
export function messageText(part: GmailPart | undefined): string {
  if (!part) return "";
  const walk = (p: GmailPart, type: string): string | undefined => {
    if (p.mimeType === type && p.body?.data) return b64url(p.body.data);
    for (const c of p.parts ?? []) {
      const t = walk(c, type);
      if (t) return t;
    }
    return undefined;
  };
  const plain = walk(part, "text/plain");
  if (plain) return plain;
  const html = walk(part, "text/html");
  return html ? html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\n{3,}/g, "\n\n") : "";
}

function attachments(part: GmailPart | undefined): string[] {
  const out: string[] = [];
  const walk = (p: GmailPart) => {
    if (p.filename) out.push(p.filename);
    for (const c of p.parts ?? []) walk(c);
  };
  if (part) walk(part);
  return out;
}

// ---------------------------------------------------------------- Google Docs (tabs)

interface DocsTextRun { content?: string }
interface DocsElement { textRun?: DocsTextRun }
interface DocsParagraph { elements?: DocsElement[]; paragraphStyle?: { namedStyleType?: string }; bullet?: { nestingLevel?: number } }
interface DocsStructural { paragraph?: DocsParagraph; table?: { tableRows?: { tableCells?: { content?: DocsStructural[] }[] }[] } }
interface DocsTab { tabProperties?: { tabId?: string; title?: string }; documentTab?: { body?: { content?: DocsStructural[] } }; childTabs?: DocsTab[] }

function paragraphText(p: DocsParagraph): string {
  return (p.elements ?? []).map((e) => e.textRun?.content ?? "").join("").replace(/\n$/, "");
}

/** Render a Docs body as light markdown: headings, bullets, tables as pipe rows. */
export function docsBodyToMarkdown(content: DocsStructural[] = []): string {
  const out: string[] = [];
  for (const s of content) {
    if (s.paragraph) {
      const text = paragraphText(s.paragraph);
      const style = s.paragraph.paragraphStyle?.namedStyleType ?? "";
      const h = /^HEADING_(\d)$/.exec(style)?.[1] ?? (style === "TITLE" ? "1" : undefined);
      if (h && text.trim()) out.push(`${"#".repeat(Math.min(6, Number(h)))} ${text.trim()}`);
      else if (s.paragraph.bullet) out.push(`${"  ".repeat(s.paragraph.bullet.nestingLevel ?? 0)}- ${text}`);
      else out.push(text);
    } else if (s.table) {
      for (const row of s.table.tableRows ?? []) {
        out.push(`| ${(row.tableCells ?? []).map((c) => docsBodyToMarkdown(c.content).replace(/\n+/g, " ").trim()).join(" | ")} |`);
      }
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function flattenTabs(tabs: DocsTab[] = [], depth = 0): { id: string; title: string; depth: number; tab: DocsTab }[] {
  return tabs.flatMap((t) => [{ id: t.tabProperties?.tabId ?? "", title: t.tabProperties?.title ?? "", depth, tab: t }, ...flattenTabs(t.childTabs, depth + 1)]);
}

export function docIdFrom(input: string): { id: string; tab?: string } {
  const id = /\/document\/d\/([A-Za-z0-9_-]+)/.exec(input)?.[1] ?? input.trim();
  const tab = /[?&#]tab=([A-Za-z0-9._-]+)/.exec(input)?.[1];
  return { id, tab };
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
