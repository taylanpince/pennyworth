import { readFileSync } from "node:fs";
import { GoogleAuthError, GoogleClient, type StoredCredentials } from "./google.js";
import { type DriveFile, type NormalizedEvent, Workspace } from "./workspace.js";

/**
 * Credentials file, multi-account:
 *   { client_id, client_secret, primary: "me@work.com",
 *     accounts: { "me@work.com": { refresh_token, scopes, client_id?, client_secret? }, … } }
 * The legacy single-account shape { client_id, client_secret, refresh_token } is accepted too.
 */
export interface CredentialsFile {
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  primary?: string;
  accounts?: Record<string, Partial<StoredCredentials>>;
}

export function loadAccounts(path: string): { primary: string; accounts: Map<string, StoredCredentials> } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as CredentialsFile;
  const accounts = new Map<string, StoredCredentials>();
  for (const [email, a] of Object.entries(raw.accounts ?? {})) {
    const client_id = a.client_id ?? raw.client_id;
    if (!client_id || !a.refresh_token) continue;
    accounts.set(email, { client_id, client_secret: a.client_secret ?? raw.client_secret, refresh_token: a.refresh_token, scopes: a.scopes });
  }
  if (!accounts.size && raw.client_id && raw.refresh_token) {
    accounts.set("default", { client_id: raw.client_id, client_secret: raw.client_secret, refresh_token: raw.refresh_token });
  }
  if (!accounts.size) throw new GoogleAuthError(`no Google accounts in ${path} (run scripts/google-auth.sh)`);
  const primary = raw.primary && accounts.has(raw.primary) ? raw.primary : [...accounts.keys()][0]!;
  return { primary, accounts };
}

const notFound = (err: unknown) => /\b(404|403)\b|not found|notFound|insufficient/i.test(String(err));

/**
 * One facade over several Google accounts.
 * Calendar and meeting documents: the primary account (where meetings live) unless `account` is given.
 * Gmail and Drive search: all accounts, each result tagged with its account.
 * Reading a thread/file/doc: the given account, else each account in turn until one has it.
 */
export class MultiWorkspace {
  readonly primary: string;
  private readonly ws = new Map<string, Workspace>();

  constructor(path: string, calendarId = "primary") {
    const { primary, accounts } = loadAccounts(path);
    this.primary = primary;
    for (const [email, creds] of accounts) this.ws.set(email, new Workspace(new GoogleClient(creds), calendarId));
  }

  accounts(): string[] {
    return [...this.ws.keys()];
  }

  private one(account?: string): [string, Workspace] {
    const name = account ?? this.primary;
    const w = this.ws.get(name);
    if (!w) throw new Error(`unknown account ${name} (known: ${this.accounts().join(", ")})`);
    return [name, w];
  }

  private order(account?: string): [string, Workspace][] {
    if (account) return [this.one(account)];
    return [this.one(), ...[...this.ws].filter(([n]) => n !== this.primary)];
  }

  private async firstThat<T>(account: string | undefined, fn: (w: Workspace) => Promise<T>): Promise<T & { account: string }> {
    let last: unknown;
    for (const [name, w] of this.order(account)) {
      try {
        return { ...(await fn(w)), account: name };
      } catch (err) {
        if (!notFound(err)) throw err;
        last = err;
      }
    }
    throw last ?? new Error("not found in any account");
  }

  async listEvents(start: string, end: string, query?: string, max = 100, account?: string): Promise<(NormalizedEvent & { account: string })[]> {
    const [name, w] = this.one(account);
    return (await w.listEvents(start, end, query, max)).map((e) => ({ ...e, account: name }));
  }

  async getEvent(id: string, account?: string) {
    return this.firstThat(account, (w) => w.getEvent(id));
  }

  async meetingDocuments(since: string, hints: string[], max = 50, account?: string) {
    const [name, w] = this.one(account);
    return (await w.meetingDocuments(since, hints, max)).map((f) => ({ ...f, account: name }));
  }

  private async all<T>(account: string | undefined, fn: (w: Workspace) => Promise<T[]>): Promise<(T & { account: string })[]> {
    const out: (T & { account: string })[] = [];
    for (const [name, w] of account ? [this.one(account)] : [...this.ws]) {
      try {
        out.push(...(await fn(w)).map((x) => ({ ...x, account: name })));
      } catch (err) {
        out.push({ account: name, error: String((err as Error).message).slice(0, 200) } as unknown as T & { account: string });
      }
    }
    return out;
  }

  recentFiles(since: string, max = 50, account?: string): Promise<(DriveFile & { account: string })[]> {
    return this.all(account, (w) => w.recentFiles(since, max));
  }

  searchFiles(query: string, max = 25, account?: string): Promise<(DriveFile & { account: string })[]> {
    return this.all(account, (w) => w.searchFiles(query, max));
  }

  readFile(id: string, maxChars?: number, account?: string) {
    return this.firstThat(account, (w) => w.readFile(id, maxChars));
  }

  readDoc(input: string, tabId?: string, maxChars?: number, account?: string) {
    return this.firstThat(account, (w) => w.readDoc(input, tabId, maxChars));
  }

  async gmailSearch(query: string, max = 20, account?: string) {
    const results = await this.all(account, (w) => w.gmailSearch(query, max));
    return results.sort((a, b) => String((b as Record<string, unknown>).date ?? "").localeCompare(String((a as Record<string, unknown>).date ?? "")));
  }

  gmailThread(id: string, maxChars?: number, account?: string) {
    return this.firstThat(account, (w) => w.gmailThread(id, maxChars));
  }
}
