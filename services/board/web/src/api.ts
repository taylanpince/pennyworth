import type { Board, Bucket, Cadence, IssueView, Models, RecurringView, Update } from "./types";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { accept: "application/json", ...(method === "GET" ? {} : { "content-type": "application/json", "x-pennyworth-board": "1" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (res.status === 401 && data.error === "pair") throw new PairRequired();
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data as T;
}

/** This device isn't paired with the board yet (LAN access, D-23). */
export class PairRequired extends Error {
  constructor() {
    super("pair");
  }
}

export interface Session {
  mode: "local" | "lan";
  paired: boolean;
  lan?: { url: string } | null;
}

export interface Device {
  id: string;
  device: string;
  createdAt: string;
  lastSeen: string;
}

export const api = {
  session: () => call<Session>("GET", "/api/session"),
  pair: (code: string, device: string) => call<{ ok: true }>("POST", "/api/pair", { code, device }),
  pairing: () => call<{ url: string; base: string; code: string; expiresAt: string }>("POST", "/api/pairing", {}),
  devices: () => call<Device[]>("GET", "/api/devices"),
  revokeDevice: (id: string) => call("DELETE", `/api/devices/${id}`),
  board: () => call<Board>("GET", "/api/board"),
  issue: (ref: string) => call<IssueView>("GET", `/api/issues/${encodeURIComponent(ref)}`),
  update: (ref: string, u: Update) => call<IssueView>("PATCH", `/api/issues/${encodeURIComponent(ref)}`, u),
  comment: (ref: string, body: string) => call<IssueView>("POST", `/api/issues/${encodeURIComponent(ref)}/comments`, { body }),
  move: (ref: string, bucket: Bucket, position: "top" | "bottom" = "top") => call("POST", `/api/issues/${encodeURIComponent(ref)}/move`, { bucket, position }),
  order: (bucket: Bucket, ids: string[]) => call("PUT", `/api/buckets/${bucket}`, { ids }),
  create: (title: string, bucket: Bucket, description = "") => call<{ id: string; identifier: string }>("POST", "/api/issues", { title, bucket, description }),
  schedule: (ref: string, body: { date: string; bucket?: Bucket } | { clear: true }) =>
    call<{ scheduled: IssueView["scheduled"]; movedNow: boolean }>("POST", `/api/issues/${encodeURIComponent(ref)}/schedule`, body),
  recurring: (ref: string, body: { action: "set"; cadence: Cadence; time: string; repos: string[] } | { action: "pause" | "resume" | "stop" | "run_now" }) =>
    call<{ recurring: RecurringView | null }>("POST", `/api/issues/${encodeURIComponent(ref)}/recurring`, body),
  models: (assignee: string) => call<Models>("GET", `/api/models/${assignee}`),
};
