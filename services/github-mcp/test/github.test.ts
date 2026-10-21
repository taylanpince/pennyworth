import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitHub, GitHubAuthError, GitHubRefused, GRAPHQL, guard, parseProject, parseRef } from "../src/github.js";

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
      ["POST", "/repos/a/b/issues"],
      ["GET", "/repos/a/b/labels"],
    ] as const)
      expect(() => guard(m, p)).not.toThrow();
    for (const query of Object.values(GRAPHQL)) expect(() => guard("POST", "/graphql", { query })).not.toThrow();
  });

  it("refuses GraphQL that isn't one of the fixed documents", () => {
    for (const body of [undefined, {}, { query: "mutation { deleteRepository(input: { repositoryId: \"x\" }) { clientMutationId } }" }, { query: GRAPHQL.addItem + " " }])
      expect(() => guard("POST", "/graphql", body), JSON.stringify(body)).toThrow(GitHubRefused);
  });

  it("refuses everything else the token could do", () => {
    for (const [m, p] of [
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
      ["GET", "/graphql"],
      ["POST", "/repos/a/b/labels"],
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

describe("parseProject", () => {
  it("reads organization project URLs only", () => {
    expect(parseProject("https://github.com/orgs/0xsequence/projects/16/views/17")).toEqual({ org: "0xsequence", number: 16 });
    expect(parseProject("github.com/orgs/a/projects/2")).toEqual({ org: "a", number: 2 });
    expect(() => parseProject("https://github.com/users/me/projects/2")).toThrow();
    expect(() => parseProject("https://github.com/a/b/issues/2")).toThrow();
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
  describe("createIssue", () => {
    const project = {
      data: {
        organization: {
          projectV2: {
            id: "P1",
            title: "Sequence Wallet",
            url: "https://github.com/orgs/0xsequence/projects/16",
            closed: false,
            field: { id: "F1", options: [{ id: "o1", name: "❄  Icebox" }, { id: "o2", name: "🔍  Triage" }] },
            items: { nodes: [{ content: { repository: { nameWithOwner: "0xsequence/issue-tracker" } } }, { content: { repository: { nameWithOwner: "0xsequence/issue-tracker" } } }, { content: { repository: { nameWithOwner: "0xsequence/other" } } }, { content: null }] },
          },
        },
      },
    };
    const created = { number: 9, node_id: "I9", html_url: "https://github.com/0xsequence/issue-tracker/issues/9", labels: [{ name: "waas" }] };
    /** GraphQL answers by document. */
    function gql(answers: Partial<Record<keyof typeof GRAPHQL, unknown>>, rest: Record<string, unknown> = {}) {
      const f = fake(rest);
      const impl = (async (input: URL | string, init?: RequestInit) => {
        if (new URL(String(input)).pathname !== "/graphql") return f.impl(input, init);
        const { query } = JSON.parse(String(init!.body));
        const name = (Object.keys(GRAPHQL) as (keyof typeof GRAPHQL)[]).find((k) => GRAPHQL[k] === query)!;
        f.calls.push({ method: "POST", url: new URL(String(input)), body: { doc: name, ...JSON.parse(String(init!.body)).variables } });
        return new Response(JSON.stringify(answers[name] ?? { errors: [{ message: "no" }] }), { status: 200 });
      }) as typeof fetch;
      return { impl, calls: f.calls };
    }

    it("opens the issue in the project's repository with labels and a status", async () => {
      const { impl, calls } = gql(
        { project, addItem: { data: { addProjectV2ItemById: { item: { id: "IT1" } } } }, setStatus: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "IT1" } } } } },
        { "GET /repos/0xsequence/issue-tracker/labels": [{ name: "bug" }, { name: "waas" }], "POST /repos/0xsequence/issue-tracker/issues": created },
      );
      const out = await new GitHub(tokenFile(), new Set(["0xsequence"]), impl).createIssue({ title: "T", body: "B", labels: ["WaaS"], project: "https://github.com/orgs/0xSequence/projects/16/views/17", status: "triage" });
      expect(out).toEqual({ repo: "0xsequence/issue-tracker", number: 9, url: created.html_url, labels: ["waas"], project: { title: "Sequence Wallet", url: project.data.organization.projectV2.url, added: true, status: "🔍  Triage" } });
      expect(calls.find((c) => c.url.pathname.endsWith("/issues"))?.body).toEqual({ title: "T", body: "B", labels: ["waas"] });
      expect(calls.at(-1)?.body).toEqual({ doc: "setStatus", project: "P1", item: "IT1", field: "F1", option: "o2" });
    });

    it("refuses before opening anything when the status, label or organization is wrong", async () => {
      const { impl, calls } = gql({ project }, { "GET /repos/0xsequence/issue-tracker/labels": [{ name: "bug" }], "POST /repos/0xsequence/issue-tracker/issues": created });
      const gh = new GitHub(tokenFile(), new Set(["0xsequence"]), impl);
      const p = "https://github.com/orgs/0xsequence/projects/16";
      await expect(gh.createIssue({ title: "T", body: "", project: p, status: "Doing" })).rejects.toThrow(/Icebox/);
      await expect(gh.createIssue({ title: "T", body: "", project: p, labels: ["waas"] })).rejects.toThrow(/no label "waas"/);
      await expect(gh.createIssue({ title: "T", body: "", repo: "someone/else" })).rejects.toBeInstanceOf(GitHubRefused);
      await expect(gh.createIssue({ title: "T", body: "", project: "https://github.com/orgs/someone/projects/1" })).rejects.toBeInstanceOf(GitHubRefused);
      await expect(gh.createIssue({ title: "T", body: "" })).rejects.toThrow(/name the repository/);
      expect(calls.some((c) => c.method === "POST" && c.url.pathname.endsWith("/issues"))).toBe(false);
    });

    it("returns the issue, not an error, when the project step fails", async () => {
      const { impl } = gql({ project }, { "POST /repos/0xsequence/issue-tracker/issues": created });
      const out = await new GitHub(tokenFile(), new Set(["0xsequence"]), impl).createIssue({ title: "T", body: "", project: "https://github.com/orgs/0xsequence/projects/16", status: "Triage" });
      expect(out.number).toBe(9);
      expect(out.project?.error).toMatch(/opened, but adding it to the project failed/);
    });
  });

  it("reports a missing or rejected token as an auth error", async () => {
    const { impl } = fake({});
    await expect(new GitHub(join(tmpdir(), "does-not-exist"), new Set(), impl).whoami()).rejects.toBeInstanceOf(GitHubAuthError);
    const unauthorized = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(new GitHub(tokenFile(), new Set(), unauthorized).whoami()).rejects.toBeInstanceOf(GitHubAuthError);
  });
});
