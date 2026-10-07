import type { Board, Bucket, IssueView, Models, Update } from "./types";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { accept: "application/json", ...(method === "GET" ? {} : { "content-type": "application/json", "x-pennyworth-board": "1" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data as T;
}

export const api = {
  board: () => call<Board>("GET", "/api/board"),
  issue: (ref: string) => call<IssueView>("GET", `/api/issues/${encodeURIComponent(ref)}`),
  update: (ref: string, u: Update) => call<IssueView>("PATCH", `/api/issues/${encodeURIComponent(ref)}`, u),
  comment: (ref: string, body: string) => call<IssueView>("POST", `/api/issues/${encodeURIComponent(ref)}/comments`, { body }),
  move: (ref: string, bucket: Bucket, position: "top" | "bottom" = "top") => call("POST", `/api/issues/${encodeURIComponent(ref)}/move`, { bucket, position }),
  order: (bucket: Bucket, ids: string[]) => call("PUT", `/api/buckets/${bucket}`, { ids }),
  create: (title: string, bucket: Bucket, description = "") => call<{ id: string; identifier: string }>("POST", "/api/issues", { title, bucket, description }),
  models: (assignee: string) => call<Models>("GET", `/api/models/${assignee}`),
};
