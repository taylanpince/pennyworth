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
  it("allows the read endpoints and the writes the user can ask for", () => {
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
      ["GET", "/repos/a/b/actions/runs"],
      ["GET", "/repos/a/b/actions/runs/123"],
      ["POST", "/repos/a/b/issues/3/labels"],
      ["DELETE", "/repos/a/b/issues/3/labels/needs%20triage"],
      ["POST", "/repos/a/b/issues/3/assignees"],
      ["DELETE", "/repos/a/b/issues/3/assignees"],
      ["POST", "/repos/a/b/actions/runs/123/rerun-failed-jobs"],
    ] as const)
      expect(() => guard(m, p)).not.toThrow();
    expect(() => guard("PATCH", "/repos/a/b/issues/3", { state: "closed", state_reason: "not_planned" })).not.toThrow();
    expect(() => guard("POST", "/repos/a/b/pulls/3/reviews", { event: "APPROVE", commit_id: "abc" })).not.toThrow();
    for (const query of Object.values(GRAPHQL)) expect(() => guard("POST", "/graphql", { query })).not.toThrow();
  });

  it("limits what an issue edit and a review may carry", () => {
    for (const body of [{ title: "x" }, { state: "closed", body: "x" }, { state: "closed", assignees: [] }, { milestone: 1 }])
      expect(() => guard("PATCH", "/repos/a/b/issues/3", body), JSON.stringify(body)).toThrow(GitHubRefused);
    for (const body of [undefined, { body: "x" }, { event: "DISMISS" }, { event: "APPROVE", comments: [] }])
      expect(() => guard("POST", "/repos/a/b/pulls/3/reviews", body), JSON.stringify(body)).toThrow(GitHubRefused);
  });

  it("refuses GraphQL that isn't one of the fixed documents", () => {
    for (const body of [undefined, {}, { query: "mutation { deleteRepository(input: { repositoryId: \"x\" }) { clientMutationId } }" }, { query: GRAPHQL.addItem + " " }])
      expect(() => guard("POST", "/graphql", body), JSON.stringify(body)).toThrow(GitHubRefused);
  });

  it("refuses everything else the token could do", () => {
    for (const [m, p] of [
      ["PATCH", "/repos/a/b/issues/comments/9"], // edit a comment
      ["DELETE", "/repos/a/b/issues/comments/9"],
      ["PUT", "/repos/a/b/pulls/3/merge"],
      ["DELETE", "/repos/a/b/git/refs/heads/main"],
      ["PUT", "/repos/a/b/contents/README.md"],
      ["GET", "/repos/a/b/contents/README.md"],
      ["GET", "/repos/a/b/issues/3/comments/../../../../user/keys"],
      ["PUT", "/repos/a/b/issues/3/labels"], // replace all labels
      ["DELETE", "/repos/a/b/issues/3/labels"], // remove all labels
      ["POST", "/repos/a/b/actions/runs/123/rerun"], // re-run every job, passing ones too
      ["POST", "/repos/a/b/actions/runs/123/cancel"],
      ["POST", "/repos/a/b/pulls/3/reviews/9/dismissals"],
      ["PUT", "/repos/a/b/pulls/3/reviews/9"],
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

  describe("D-46 writes", () => {
    const issue7 = { ...issue, comments: 0, labels: [{ name: "bug" }, { name: "needs triage" }], assignees: [] };

    it("closes an issue as not planned and changes labels, with existing labels only", async () => {
      const { impl, calls } = fake({ "GET /repos/a/b/issues/7": issue7, "GET /repos/a/b/labels": [{ name: "WaaS" }, { name: "bug" }], "POST /repos/a/b/issues/7/labels": [], "DELETE /repos/a/b/issues/7/labels/needs%20triage": [], "PATCH /repos/a/b/issues/7": {} });
      const gh = new GitHub(tokenFile(), new Set(["a"]), impl);
      const out = (await gh.updateIssue({ owner: "a", repo: "b", number: 7 }, { state: "closed", reason: "not_planned", addLabels: ["waas"], removeLabels: ["Needs Triage"] })) as { done: string[] };
      expect(out.done).toEqual(["added labels WaaS", "removed label needs triage", "closed as not planned"]);
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ state: "closed", state_reason: "not_planned" });
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ labels: ["WaaS"] });
    });

    it("refuses a missing label, closing a pull request, and other organizations before writing", async () => {
      const { impl, calls } = fake({ "GET /repos/a/b/issues/7": issue7, "GET /repos/a/b/issues/8": { ...issue7, pull_request: {} }, "GET /repos/a/b/labels": [{ name: "bug" }] });
      const gh = new GitHub(tokenFile(), new Set(["a"]), impl);
      await expect(gh.updateIssue({ owner: "a", repo: "b", number: 7 }, { addLabels: ["nope"] })).rejects.toThrow(/has no label "nope"/);
      await expect(gh.updateIssue({ owner: "a", repo: "b", number: 8 }, { state: "closed" })).rejects.toThrow(/pull requests aren't closed/);
      await expect(gh.updateIssue({ owner: "x", repo: "b", number: 7 }, { state: "closed" })).rejects.toBeInstanceOf(GitHubRefused);
      expect(calls.every((c) => c.method === "GET")).toBe(true);
    });

    it("reviews at the head it read, and needs text unless approving", async () => {
      const { impl, calls } = fake({ "GET /repos/a/b/pulls/7": { state: "open", head: { sha: "abc" } }, "POST /repos/a/b/pulls/7/reviews": { id: 5, html_url: "h", state: "APPROVED" } });
      const gh = new GitHub(tokenFile(), new Set(["a"]), impl);
      await expect(gh.review({ owner: "a", repo: "b", number: 7 }, "APPROVE", "")).resolves.toEqual({ id: 5, url: "h", state: "APPROVED" });
      expect(calls.at(-1)?.body).toEqual({ event: "APPROVE", commit_id: "abc" });
      await expect(gh.review({ owner: "a", repo: "b", number: 7 }, "REQUEST_CHANGES", " ")).rejects.toBeInstanceOf(GitHubRefused);
      await expect(gh.review({ owner: "x", repo: "b", number: 7 }, "APPROVE", "")).rejects.toBeInstanceOf(GitHubRefused);
    });

    it("re-runs only the latest failed run of each workflow on a pull request", async () => {
      const run = (id: number, workflow_id: number, conclusion: string, created_at: string) => ({ id, name: `w${workflow_id}`, html_url: `h${id}`, status: "completed", conclusion, head_sha: "abc", workflow_id, created_at });
      const { impl, calls } = fake({
        "GET /repos/a/b/pulls/7": { head: { sha: "abc" } },
        "GET /repos/a/b/actions/runs": { workflow_runs: [run(1, 10, "failure", "1"), run(2, 10, "success", "2"), run(3, 20, "failure", "1"), run(4, 30, "success", "1")] },
        "POST /repos/a/b/actions/runs/3/rerun-failed-jobs": {},
      });
      const out = (await new GitHub(tokenFile(), new Set(["a"]), impl).rerunFailed({ pr: { owner: "a", repo: "b", number: 7 } })) as { rerun: { url: string }[] };
      expect(out.rerun).toEqual([{ name: "w20", url: "h3" }]);
      expect(calls.filter((c) => c.method === "POST").map((c) => c.url.pathname)).toEqual(["/repos/a/b/actions/runs/3/rerun-failed-jobs"]);
    });
  });

  it("reports a missing or rejected token as an auth error", async () => {
    const { impl } = fake({});
    await expect(new GitHub(join(tmpdir(), "does-not-exist"), new Set(), impl).whoami()).rejects.toBeInstanceOf(GitHubAuthError);
    const unauthorized = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(new GitHub(tokenFile(), new Set(), unauthorized).whoami()).rejects.toBeInstanceOf(GitHubAuthError);
  });
});
