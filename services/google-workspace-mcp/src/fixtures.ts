import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DriveFile, NormalizedEvent } from "./workspace.js";

interface FixtureDoc extends DriveFile {
  text: string;
}

/**
 * Serves calendar events and Drive documents from JSON fixtures instead of Google.
 * Layout: <dir>/calendar/*.json (arrays of NormalizedEvent), <dir>/drive/*.json
 * (arrays of {id, name, mimeType, modifiedTime, webViewLink, text}).
 */
export class FixtureWorkspace {
  private readonly events: NormalizedEvent[];
  private readonly docs: FixtureDoc[];

  constructor(dir: string) {
    this.events = readJsonArrays<Partial<NormalizedEvent>>(join(dir, "calendar")).map((e) => ({ all_day: false, attendees: [], attachments: [], ...e }) as NormalizedEvent);
    this.docs = readJsonArrays<FixtureDoc>(join(dir, "drive"));
  }

  async listEvents(start: string, end: string, query?: string, max = 100): Promise<NormalizedEvent[]> {
    const s = Date.parse(start);
    const e = Date.parse(end);
    return this.events
      .filter((ev) => Date.parse(ev.end) > s && Date.parse(ev.start) < e)
      .filter((ev) => !query || ev.title.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
      .slice(0, max);
  }

  async getEvent(id: string): Promise<NormalizedEvent> {
    const ev = this.events.find((x) => x.id === id);
    if (!ev) throw new Error(`fixture event not found: ${id}`);
    return ev;
  }

  async recentFiles(since: string, max = 50): Promise<DriveFile[]> {
    return this.docs.filter((d) => !d.modifiedTime || d.modifiedTime > since).slice(0, max).map(strip);
  }

  async meetingDocuments(since: string, nameHints: string[], max = 50): Promise<DriveFile[]> {
    return (await this.recentFiles(since, 500)).filter((d) => nameHints.some((h) => d.name.includes(h))).slice(0, max);
  }

  async searchFiles(query: string, max = 25): Promise<DriveFile[]> {
    const q = query.toLowerCase();
    return this.docs.filter((d) => d.name.toLowerCase().includes(q) || d.text.toLowerCase().includes(q)).slice(0, max).map(strip);
  }

  async readFile(id: string): Promise<{ file: DriveFile; text: string; truncated: boolean }> {
    const d = this.docs.find((x) => x.id === id);
    if (!d) throw new Error(`fixture document not found: ${id}`);
    return { file: strip(d), text: d.text, truncated: false };
  }
}

function strip({ text: _text, ...file }: FixtureDoc): DriveFile {
  return file;
}

function readJsonArrays<T>(dir: string): T[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as T[]);
}
