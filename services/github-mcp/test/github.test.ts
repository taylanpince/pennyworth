import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitHub, GitHubAuthError, GitHubRefused, guard, parseRef } from "../src/github.js";

function tokenFile(content = "gho_test"): string {
  const f = join(mkdtempSync(join(tmpdir(), "github-mcp-")), "token");
  writeFileSync(f, content);
  return f;
}

/** A fake GitHub that records every request and answers from `routes` (pathname → body). */
function fake(routes: Record<string, unknown>) {
  const calls: { method: string; url: URL; body?: unknown; auth?: string }[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as Record<string, string>)?.authorization });
    const key = `${init?.method ?? "GET"} ${url.pathname}${url.searchParams.get("page") ? `?page=${url.searchParams.get("page")}` : ""}`;
    const hit = routes[key] ?? routes[`${init?.method ?? "GET"} ${url.pathname}`];
    if (hit === undefined) return new Response("Not Found", { status: 404 });
    return new Response(JSON.stringify(hit), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("guard", () => {
  it("allows the read endpoints and issue comments only", () => {
    for (const [m, p] of [
      ["GET", "/user"],
      ["GET", "/repos/0xsequence/issue-tracker/issues/7334"],
      ["GET", "/repos/0xsequence/issue-tracker/issues/7334/comments"],
      ["GET", "/repos/a/b/pulls/3"],
      ["GET", "/repos/a/b/pulls/3/reviews"],
      ["GET", "/search/issues"],
      ["POST", "/repos/a/b/issues/3/comments"],
    ] as const)
      expect(() => guard(m, p)).not.toThrow();
  });

  it("refuses everything else the token could do", () => {
    for (const [m, p] of [
      ["POST", "/repos/a/b/issues"], // new issue
      ["PATCH", "/repos/a/b/issues/3"], // close, retitle
      ["PATCH", "/repos/a/b/issues/comments/9"], // edit a comment
      ["DELETE", "/repos/a/b/issues/comments/9"],
      ["PUT", "/repos/a/b/pulls/3/merge"],
      ["POST", "/repos/a/b/pulls/3/reviews"], // approve
      ["DELETE", "/repos/a/b/git/refs/heads/main"],
      ["PUT", "/repos/a/b/contents/README.md"],
      ["GET", "/repos/a/b/contents/README.md"],
      ["POST", "/repos/a/b/issues/3/labels"],
      ["GET", "/repos/a/b/issues/3/comments/../../../../user/keys"],
      ["POST", "/graphql"],
      ["GET", "/user/repos"],
    ] as const)
      expect(() => guard(m, p), `${m} ${p}`).toThrow(GitHubRefused);
  });

  it("refuses paths that URL resolution would move", async () => {
    const { impl, calls } = fake({});
    const gh = new GitHub(tokenFile(), new Set(["a"]), impl);
    await expect(gh.request("GET", "/repos/../../user/issues/1")).rejects.toBeInstanceOf(GitHubRefused);
    await expect(gh.comment({ owner: "a", repo: "..", number: 1 }, "x")).rejects.toBeInstanceOf(GitHubRefused);
    expect(calls).toHaveLength(0);
  });
});

describe("parseRef", () => {
  it("reads URLs, short refs and repo plus number", () => {
    expect(parseRef({ url: "https://github.com/0xsequence/issue-tracker/issues/7334" })).toEqual({ owner: "0xsequence", repo: "issue-tracker", number: 7334 });
    expect(parseRef({ url: "https://github.com/a/b/pull/12/files#diff-1" })).toEqual({ owner: "a", repo: "b", number: 12 });
    expect(parseRef({ url: "https://github.com/a/b/issues/5#issuecomment-99" })).toEqual({ owner: "a", repo: "b", number: 5 });
    expect(parseRef({ url: "a/b#7" })).toEqual({ owner: "a", repo: "b", number: 7 });
    expect(parseRef({ repo: "https://github.com/a/b/", number: 3 })).toEqual({ owner: "a", repo: "b", number: 3 });
  });

  it("rejects anything else", () => {
    expect(() => parseRef({ url: "https://gitlab.com/a/b/issues/1" })).toThrow();
    expect(() => parseRef({ url: "https://github.com/a/b" })).toThrow();
    expect(() => parseRef({ repo: "a/b/c", number: 1 })).toThrow();
    expect(() => parseRef({ repo: "a/b" })).toThrow();
  });
});

describe("GitHub", () => {
  const issue = { number: 7, html_url: "https://github.com/a/b/issues/7", repository_url: "https://api.github.com/repos/a/b", title: "T", state: "open", user: { login: "x" }, labels: [{ name: "bug" }], created_at: "c", updated_at: "u", body: "B", comments: 150 };

  it("reads an issue with its newest comments, oldest first", async () => {
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, html_url: "h", user: { login: "y" }, created_at: "t", body: `c${from + i}` }));
    const { impl, calls } = fake({ "GET /repos/a/b/issues/7": issue, "GET /repos/a/b/issues/7/comments?page=2": page(101, 50), "GET /repos/a/b/issues/7/comments?page=1": page(1, 100) });
    const out = (await new GitHub(tokenFile(), new Set(), impl).read({ owner: "a", repo: "b", number: 7 }, 60)) as { comments: { id: number }[]; kind: string; labels: string[] };
    expect(out.kind).toBe("issue");
    expect(out.labels).toEqual(["bug"]);
    expect(out.comments.map((c) => c.id)).toEqual(Array.from({ length: 60 }, (_, i) => 91 + i));
    expect(calls.every((c) => c.method === "GET" && c.auth === "Bearer gho_test")).toBe(true);
  });

  it("adds merge state and reviews for a pull request", async () => {
    const { impl } = fake({
      "GET /repos/a/b/issues/7": { ...issue, comments: 0, pull_request: {} },
      "GET /repos/a/b/issues/7/comments": [],
      "GET /repos/a/b/pulls/7": { draft: false, merged: true, base: { ref: "main" }, head: { ref: "feat/x" } },
      "GET /repos/a/b/pulls/7/reviews": [{ user: { login: "r" }, state: "APPROVED", body: "" }],
    });
    const out = (await new GitHub(tokenFile(), new Set(), impl).read({ owner: "a", repo: "b", number: 7 })) as { kind: string; pull_request: { merged: boolean; reviews: unknown[] } };
    expect(out.kind).toBe("pull_request");
    expect(out.pull_request.merged).toBe(true);
    expect(out.pull_request.reviews).toHaveLength(1);
  });

  it("comments only in the allowed organizations", async () => {
    const { impl, calls } = fake({ "POST /repos/0xSequence/b/issues/7/comments": { id: 1, html_url: "https://github.com/0xSequence/b/issues/7#issuecomment-1" } });
    const gh = new GitHub(tokenFile(), new Set(["0xsequence"]), impl);
    await expect(gh.comment({ owner: "0xSequence", repo: "b", number: 7 }, "Update")).resolves.toEqual({ id: 1, url: "https://github.com/0xSequence/b/issues/7#issuecomment-1" });
    expect(calls[0]?.body).toEqual({ body: "Update" });
    await expect(gh.comment({ owner: "someone", repo: "b", number: 7 }, "Update")).rejects.toBeInstanceOf(GitHubRefused);
    expect(calls).toHaveLength(1);
  });

  it("reports a missing or rejected token as an auth error", async () => {
    const { impl } = fake({});
    await expect(new GitHub(join(tmpdir(), "does-not-exist"), new Set(), impl).whoami()).rejects.toBeInstanceOf(GitHubAuthError);
    const unauthorized = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(new GitHub(tokenFile(), new Set(), unauthorized).whoami()).rejects.toBeInstanceOf(GitHubAuthError);
  });
});
