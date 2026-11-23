import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adfFromText, textFromAdf } from "../src/adf.js";
import { Jira, JiraRefused, guard, parseRef, readAuth } from "../src/jira.js";

function authFile(auth: { baseUrl?: string; email?: string; token?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "jira-mcp-"));
  const f = join(dir, "auth.json");
  writeFileSync(f, JSON.stringify({ baseUrl: "https://acme.atlassian.net", email: "u@acme.io", token: "t0ken", ...auth }));
  return f;
}

/** A fake Jira that records every request and answers from `routes` (method + pathname → body). */
function fake(routes: Record<string, unknown>) {
  const calls: { method: string; url: URL; body?: unknown; auth?: string }[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as Record<string, string>)?.authorization });
    const hit = routes[`${init?.method ?? "GET"} ${url.pathname}`];
    if (hit === undefined) return new Response("Not Found", { status: 404 });
    return new Response(JSON.stringify(hit), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("guard", () => {
  it("allows the reads and the writes", () => {
    for (const [m, p] of [
      ["GET", "/rest/api/3/myself"],
      ["GET", "/rest/api/3/issue/PROJ-123"],
      ["GET", "/rest/api/3/issue/PROJ-123/transitions"],
      ["GET", "/rest/api/3/user/search"],
      ["POST", "/rest/api/3/issue"],
      ["POST", "/rest/api/3/issue/PROJ-123/comment"],
      ["POST", "/rest/api/3/issue/PROJ-123/transitions"],
      ["POST", "/rest/api/3/search/jql"],
    ] as const)
      expect(() => guard(m, p)).not.toThrow();
  });

  it("refuses everything else", () => {
    expect(() => guard("DELETE", "/rest/api/3/issue/PROJ-1")).toThrow(JiraRefused);
    expect(() => guard("PUT", "/rest/api/3/issue/PROJ-1")).not.toThrow();
    expect(() => guard("PUT", "/rest/api/3/issue/PROJ-1/assignee")).not.toThrow();
    expect(() => guard("GET", "/rest/api/3/users")).toThrow(JiraRefused);
    expect(() => guard("GET", "/rest/api/3/issue/PROJ-123/worklog")).toThrow(JiraRefused);
    expect(() => guard("POST", "/rest/api/3/issue/PROJ-1/transitions", { transition: { id: "31" }, fields: {} })).toThrow(JiraRefused);
    expect(() => guard("POST", "/rest/api/3/issue/PROJ-1/transitions", { update: {} })).toThrow(JiraRefused);
    expect(() => guard("PUT", "/rest/api/3/issue/PROJ-1/assignee", { accountId: "a", extra: true })).toThrow(JiraRefused);
    expect(() => guard("PUT", "/rest/api/3/issue/PROJ-1", { fields: { parent: { key: "P-1" } } })).not.toThrow();
    expect(() => guard("PUT", "/rest/api/3/issue/PROJ-1", { fields: { summary: "x" } })).toThrow(JiraRefused);
    expect(() => guard("DELETE", "/rest/api/3/issue/PROJ-1")).toThrow(JiraRefused);
  });

  it("limits bodies to their fixed fields", () => {
    expect(() => guard("POST", "/rest/api/3/issue/PROJ-1/comment", { body: {}, public: true })).toThrow(JiraRefused);
    expect(() => guard("POST", "/rest/api/3/search/jql", { jql: "project = X", maxResults: 5, fields: ["summary"], nextPageToken: "t" })).toThrow(JiraRefused);
    expect(() => guard("POST", "/rest/api/3/issue", { fields: { summary: "x", project: { key: "P" }, issuetype: { name: "Task" }, duedate: "2026-01-01" } })).toThrow(JiraRefused);
    expect(() => guard("POST", "/rest/api/3/issue", { fields: { summary: "x", project: { key: "P" }, issuetype: { name: "Task" }, description: { type: "doc" }, labels: ["a"], parent: { key: "P-1" }, assignee: { id: "acc" } } })).not.toThrow();
    expect(() => guard("POST", "/rest/api/3/issue/PROJ-1/transitions", { transition: { id: "31" } })).not.toThrow();
  });
});

describe("parseRef", () => {
  it("takes a key or a browse URL, with a query", () => {
    expect(parseRef({ key: "PROJ-123" })).toBe("PROJ-123");
    expect(parseRef({ url: "https://acme.atlassian.net/browse/AB1-9" })).toBe("AB1-9");
    expect(parseRef({ url: "https://acme.atlassian.net/jira/board?selectedIssue=XY-2&issueLimit=100" })).toBe("XY-2");
    expect(() => parseRef({ url: "https://acme.atlassian.net/browse/PROJ-123?focusedCommentId=1" })).not.toThrow();
    expect(() => parseRef({ key: "not a key" })).toThrow();
  });
});

describe("adf", () => {
  it("plain text becomes paragraphs and bullet lists, with hardBreaks for single newlines", () => {
    const doc = adfFromText("Line one\nLine two\n\n- item one\n- item two");
    expect(doc).toEqual({
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Line one" }, { type: "hardBreak" }, { type: "text", text: "Line two" }] },
        { type: "bulletList", content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item one" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item two" }] }] },
        ] },
      ],
    });
  });

  it("round-trips what Jira returns back to plain text", () => {
    const adf = adfFromText("Para one.\nSecond line.\n\n- a\n- b");
    expect(textFromAdf(adf)).toBe("Para one.\nSecond line.\n\n- a\n- b");
  });
});

describe("Jira", () => {
  it("refuses writes outside the allowed projects", async () => {
    const { impl } = fake({ "GET /rest/api/3/issue/PROJ-1": { key: "PROJ-1", fields: { project: { key: "OTHER" }, comment: { total: 0, comments: [] } } } });
    const jira = new Jira(authFile({}), new Set(["PROJ"]), impl);
    await expect(jira.createIssue({ project: "OTHER", summary: "s", description: "" })).rejects.toThrow(JiraRefused);
    await expect(jira.comment({ key: "PROJ-1" }, "hi")).rejects.toThrow(/limited to PROJ; OTHER is read-only/);
  });

  it("reads an issue with its comments, as plain text", async () => {
    const { impl, calls } = fake({
      "GET /rest/api/3/issue/PROJ-1": { key: "PROJ-1", fields: {
        project: { key: "PROJ" }, issuetype: { name: "Task" }, status: { name: "In Progress" }, summary: "Fix login",
        description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "It breaks" }, { type: "hardBreak" }, { type: "text", text: "often" }] }] },
        assignee: { displayName: "Grace" }, reporter: { displayName: "Ada" }, created: "2026-11-01T00:00:00Z", updated: "2026-11-02T00:00:00Z",
        priority: { name: "High" }, labels: ["infra"],
        comment: { total: 2, comments: [
          { author: { displayName: "Ada" }, created: "2026-11-01T01:00:00Z", body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "First" }] }] } },
          { author: { displayName: "Grace" }, created: "2026-11-01T02:00:00Z", body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Second" }] }] } },
        ] },
      } },
    });
    const jira = new Jira(authFile({}), new Set(), impl);
    const out = (await jira.read({ key: "PROJ-1" })) as Record<string, unknown>;
    expect(out).toMatchObject({ key: "PROJ-1", url: "https://acme.atlassian.net/browse/PROJ-1", summary: "Fix login", status: "In Progress", description: "It breaks\noften", comments_total: 2, comments: [{ body: "First" }, { body: "Second" }] });
    expect(calls[0]!.url.pathname).toBe("/rest/api/3/issue/PROJ-1");
    expect(calls[0]!.auth).toBe("Basic " + Buffer.from("u@acme.io:t0ken").toString("base64"));
  });

  it("creates an issue in an allowed project", async () => {
    const { impl, calls } = fake({ "POST /rest/api/3/issue": { key: "PROJ-100" } });
    const jira = new Jira(authFile({}), new Set(["PROJ"]), impl);
    const out = await jira.createIssue({ project: "proj", summary: "S", description: "D\n\nE", labels: ["x"] });
    expect(out).toEqual({ key: "PROJ-100", url: "https://acme.atlassian.net/browse/PROJ-100" });
    expect(calls[0]!.body).toEqual({ fields: { project: { key: "PROJ" }, issuetype: { name: "Task" }, summary: "S", description: adfFromText("D\n\nE"), labels: ["x"] } });
  });

  it("creates under a parent, assigned by name, and moves it to a status", async () => {
    const { impl, calls } = fake({
      "GET /rest/api/3/user/search": [{ accountId: "acc-1", displayName: "Nicholas Gioachini", active: true }],
      "POST /rest/api/3/issue": { key: "PROJ-101" },
      "GET /rest/api/3/issue/PROJ-101/transitions": { transitions: [{ id: "31", name: "Done", to: { name: "Done" } }, { id: "11", name: "In Progress", to: { name: "In Progress" } }] },
      "POST /rest/api/3/issue/PROJ-101/transitions": {},
    });
    const jira = new Jira(authFile({}), new Set(["PROJ"]), impl);
    const out = await jira.createIssue({ project: "PROJ", summary: "S", description: "", parent: "PROJ-966", assignee: "nicholas gioachini", status: "done" });
    expect(out).toEqual({ key: "PROJ-101", url: "https://acme.atlassian.net/browse/PROJ-101", parent: "PROJ-966", status: "Done" });
    expect(calls.find((c) => c.url.pathname === "/rest/api/3/user/search")!.url.searchParams.get("query")).toBe("nicholas gioachini");
    expect(calls.find((c) => c.url.pathname === "/rest/api/3/issue")!.body).toEqual({ fields: { project: { key: "PROJ" }, issuetype: { name: "Task" }, summary: "S", description: adfFromText(""), parent: { key: "PROJ-966" }, assignee: { id: "acc-1" } } });
    expect(calls.find((c) => c.url.pathname === "/rest/api/3/issue/PROJ-101/transitions" && c.method === "POST")!.body).toEqual({ transition: { id: "31" } });
  });

  it("reports a status the workflow doesn't offer instead of failing the created issue", async () => {
    const { impl } = fake({
      "POST /rest/api/3/issue": { key: "PROJ-102" },
      "GET /rest/api/3/issue/PROJ-102/transitions": { transitions: [{ id: "11", name: "In Progress", to: { name: "In Progress" } }] },
    });
    const jira = new Jira(authFile({}), new Set(["PROJ"]), impl);
    const out = await jira.createIssue({ project: "PROJ", summary: "S", description: "", status: "Nonexistent" });
    expect(out.key).toBe("PROJ-102");
    expect(out.status_error).toMatch(/no transition to "Nonexistent"/);
  });

  it("refuses an ambiguous or unknown assignee before the issue exists", async () => {
    const { impl, calls } = fake({
      "GET /rest/api/3/user/search": [
        { accountId: "acc-1", displayName: "Ada Lovelace" },
        { accountId: "acc-2", displayName: "Ada Lovelace" },
      ],
      "POST /rest/api/3/issue": { key: "PROJ-103" },
    });
    const jira = new Jira(authFile({}), new Set(["PROJ"]), impl);
    await expect(jira.createIssue({ project: "PROJ", summary: "S", description: "", assignee: "Ada Lovelace" })).rejects.toThrow(/several users/);
    await expect(jira.createIssue({ project: "PROJ", summary: "S", description: "", assignee: "Nobody" })).rejects.toThrow(/no user "Nobody"/);
    expect(calls.filter((c) => c.method === "POST" && c.url.pathname === "/rest/api/3/issue")).toHaveLength(0);
  });

  it("changes an existing issue: parent, assignee and status, prechecked", async () => {
    const issue = { key: "PROJ-1077", fields: { project: { key: "PROJ" }, issuetype: { name: "Task" }, status: { name: "To Do" }, summary: "S", description: null, assignee: null, reporter: null, created: "c", updated: "u", priority: null, labels: [], comment: { total: 0, comments: [] } } };
    const { impl, calls } = fake({
      "GET /rest/api/3/issue/PROJ-1077": issue,
      "GET /rest/api/3/user/search": [{ accountId: "acc-1", displayName: "Nicholas Gioachini", active: true }],
      "GET /rest/api/3/issue/PROJ-1077/transitions": { transitions: [{ id: "31", name: "Done", to: { name: "Done" } }] },
      "PUT /rest/api/3/issue/PROJ-1077": {},
      "PUT /rest/api/3/issue/PROJ-1077/assignee": {},
      "POST /rest/api/3/issue/PROJ-1077/transitions": {},
    });
    const jira = new Jira(authFile({}), new Set(["PROJ"]), impl);
    const out = (await jira.updateIssue({ key: "PROJ-1077" }, { parent: "PROJ-966", assignee: "Nicholas Gioachini", status: "Done" })) as Record<string, unknown>;
    expect(out).toMatchObject({ key: "PROJ-1077", done: ["parent PROJ-966", "assigned Nicholas Gioachini", "status Done"] });
    const paths = calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url.pathname}`);
    expect(paths).toEqual(["PUT /rest/api/3/issue/PROJ-1077", "PUT /rest/api/3/issue/PROJ-1077/assignee", "POST /rest/api/3/issue/PROJ-1077/transitions"]);
  });

  it("refuses changing an issue outside the allowed projects, or with a status the workflow doesn't offer", async () => {
    const { impl, calls } = fake({
      "GET /rest/api/3/issue/OTHER-1": { key: "OTHER-1", fields: { project: { key: "OTHER" }, comment: { total: 0, comments: [] } } },
      "GET /rest/api/3/issue/PROJ-1": { key: "PROJ-1", fields: { project: { key: "PROJ" }, status: { name: "To Do" }, assignee: null, comment: { total: 0, comments: [] } } },
      "GET /rest/api/3/issue/PROJ-1/transitions": { transitions: [{ id: "11", name: "In Progress", to: { name: "In Progress" } }] },
    });
    const jira = new Jira(authFile({}), new Set(["PROJ"]), impl);
    await expect(jira.updateIssue({ key: "OTHER-1" }, { status: "Done" })).rejects.toThrow(JiraRefused);
    await expect(jira.updateIssue({ key: "PROJ-1" }, { status: "Done" })).rejects.toThrow(/no transition to "Done"/);
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("assigns 'me' as the signed-in account", async () => {
    const { impl, calls } = fake({
      "GET /rest/api/3/myself": { displayName: "Nicholas Gioachini", emailAddress: "u@acme.io", accountId: "me-1" },
      "POST /rest/api/3/issue": { key: "PROJ-104" },
    });
    const jira = new Jira(authFile({}), new Set(["PROJ"]), impl);
    await jira.createIssue({ project: "PROJ", summary: "S", description: "", assignee: "me" });
    expect(calls.find((c) => c.url.pathname === "/rest/api/3/issue")!.body).toEqual({ fields: { project: { key: "PROJ" }, issuetype: { name: "Task" }, summary: "S", description: adfFromText(""), assignee: { id: "me-1" } } });
  });

  it("comments only in an allowed project, after reading the issue", async () => {
    const { impl, calls } = fake({
      "GET /rest/api/3/issue/OTHER-1": { key: "OTHER-1", fields: { project: { key: "OTHER" }, comment: { total: 0, comments: [] } } },
      "GET /rest/api/3/issue/PROJ-1": { key: "PROJ-1", fields: { project: { key: "PROJ" }, comment: { total: 0, comments: [] } } },
      "POST /rest/api/3/issue/PROJ-1/comment": { id: 999 },
    });
    const jira = new Jira(authFile({}), new Set(["PROJ"]), impl);
    await expect(jira.comment({ key: "OTHER-1" }, "no")).rejects.toThrow(JiraRefused);
    await expect(jira.comment({ key: "PROJ-1" }, "A line\nAnother")).resolves.toEqual({ url: "https://acme.atlassian.net/browse/PROJ-1?focusedCommentId=999" });
    expect(calls.at(-1)!.url.pathname).toBe("/rest/api/3/issue/PROJ-1/comment");
    expect((calls.at(-1)!.body as { body: unknown }).body).toEqual(adfFromText("A line\nAnother"));
  });

  it("searches with JQL and returns keys and links", async () => {
    const { impl, calls } = fake({ "POST /rest/api/3/search/jql": { issues: [{ key: "PROJ-1", fields: { summary: "S", status: { name: "Open" }, issuetype: { name: "Bug" }, assignee: { displayName: "Ada" }, updated: "2026-11-01T00:00:00Z" } }] } });
    const jira = new Jira(authFile({}), new Set(), impl);
    const out = (await jira.search("project = PROJ", 10)) as { items: unknown[] };
    expect(out).toMatchObject({ total: 1 });
    expect((out.items[0] as { url: string }).url).toBe("https://acme.atlassian.net/browse/PROJ-1");
    expect(calls[0]!.body).toEqual({ jql: "project = PROJ", maxResults: 10, fields: ["summary", "status", "issuetype", "assignee", "updated"] });
  });

  it("readAuth refuses a missing or partial sign-in", () => {
    expect(() => readAuth(authFile({ token: "" }))).toThrow();
    expect(() => readAuth("/nonexistent")).toThrow(/jira-auth\.sh/);
  });
});
