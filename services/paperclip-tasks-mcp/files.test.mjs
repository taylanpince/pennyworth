import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

// The incident on 2026-11-22: Ada's ledger was on her part, and Ursula, on hers, couldn't find it.
test("task_files with crew lists every part's files, and a long comment says it was cut", async (t) => {
  const issues = {
    task: { id: "task", identifier: "PEN-1", parentId: null, assigneeUserId: "owner" },
    ada: { id: "ada", identifier: "PEN-2", parentId: "task", assigneeAgentId: "a-ada" },
    ursula: { id: "ursula", identifier: "PEN-3", parentId: "task", assigneeAgentId: "a-ursula" },
  };
  const files = { task: [{ id: "f1", originalFilename: "incident.md", contentType: "text/markdown", byteSize: 10, createdAt: "1", createdByUserId: "owner" }], ada: [{ id: "f2", originalFilename: "losses_by_wallet.csv", contentType: "text/csv", byteSize: 27497, createdAt: "2", createdByUserId: "owner" }], ursula: [] };
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url, "http://x");
    let m;
    if (url.pathname === "/api/companies/company") return res.end(JSON.stringify({ defaultResponsibleUserId: "owner" }));
    if (url.pathname === "/api/companies/company/agents") return res.end(JSON.stringify([{ id: "a-ada", metadata: { persona: { name: "Ada" } } }, { id: "a-ursula", metadata: { persona: { name: "Ursula" } } }]));
    if (url.pathname === "/api/companies/company/issues") return res.end(JSON.stringify(Object.values(issues).filter((i) => i.parentId === url.searchParams.get("parentId"))));
    if ((m = /^\/api\/issues\/([^/]+)\/attachments$/.exec(url.pathname))) return res.end(JSON.stringify(files[Object.values(issues).find((i) => i.id === m[1] || i.identifier === m[1]).id]));
    if ((m = /^\/api\/issues\/([^/]+)\/comments$/.exec(url.pathname))) return res.end(JSON.stringify([{ id: "c1", authorType: "user", body: `${"row\n".repeat(6000)}<!-- pennyworth-runner -->`, createdAt: "1" }]));
    if ((m = /^\/api\/issues\/([^/]+)$/.exec(url.pathname))) return res.end(JSON.stringify(Object.values(issues).find((i) => i.id === m[1] || i.identifier === m[1])));
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const child = spawn(process.execPath, [new URL("./paperclip-tasks-mcp.mjs", import.meta.url).pathname], {
    env: { ...process.env, PAPERCLIP_API_URL: `http://127.0.0.1:${server.address().port}`, PAPERCLIP_COMPANY_ID: "company", PAPERCLIP_API_KEY: "test" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout });
  t.after(() => { lines.close(); child.kill(); server.close(); server.closeAllConnections(); });
  let id = 0;
  const call = async (name, args) => {
    const response = once(lines, "line");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    return JSON.parse(JSON.parse((await response)[0]).result.content[0].text);
  };
  const own = await call("task_files", { issue: "PEN-3" });
  assert.deepEqual(own.files, [], "Ursula's own part has nothing on it");
  const all = await call("task_files", { issue: "PEN-3", crew: true });
  assert.equal(all.task, "PEN-1");
  assert.deepEqual(all.files.map((f) => [f.name, f.issue, f.on]), [["incident.md", "PEN-1", "the user's task"], ["losses_by_wallet.csv", "PEN-2", "Ada's part"]]);
  const comments = await call("task_comments", { issue: "PEN-2" });
  assert.equal(comments.comments[0].truncated, true);
  assert.match(comments.comments[0].body, /… \(cut: 3999 more characters\. Long data is better read from the task's files: task_files with crew: true\.\)$/);
});

// PEN-5797, 2026-11-23: Ursula split a 230,000-character report across fourteen comments, and the task's history
// outgrew what Paperclip can hand an agent. A long draft is a file on her own part.
test("task_attach puts a file on the agent's own part, replaces its earlier version, and refuses anywhere else", async (t) => {
  const issues = {
    task: { id: "task", identifier: "PEN-1", parentId: null, assigneeUserId: "owner" },
    ada: { id: "ada", identifier: "PEN-2", parentId: "task", assigneeAgentId: "a-ada" },
    ursula: { id: "ursula", identifier: "PEN-3", parentId: "task", assigneeAgentId: "a-ursula" },
  };
  const files = { ursula: [{ id: "old", originalFilename: "report.md" }] };
  const uploads = [];
  const deleted = [];
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url, "http://x");
    let m;
    if (url.pathname === "/api/companies/company") return res.end(JSON.stringify({ defaultResponsibleUserId: "owner" }));
    if (url.pathname === "/api/agents/me") return res.end(JSON.stringify({ id: "a-ursula" }));
    if ((m = /^\/api\/companies\/company\/issues\/([^/]+)\/attachments$/.exec(url.pathname)) && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      uploads.push({ issue: m[1], type: req.headers["content-type"], body });
      return res.end(JSON.stringify({ id: "new" }));
    }
    if ((m = /^\/api\/attachments\/([^/]+)$/.exec(url.pathname)) && req.method === "DELETE") {
      deleted.push(m[1]);
      return res.end("{}");
    }
    if ((m = /^\/api\/issues\/([^/]+)\/attachments$/.exec(url.pathname))) return res.end(JSON.stringify(files[m[1]] ?? []));
    if ((m = /^\/api\/issues\/([^/]+)$/.exec(url.pathname))) return res.end(JSON.stringify(Object.values(issues).find((i) => i.id === m[1] || i.identifier === m[1])));
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const child = spawn(process.execPath, [new URL("./paperclip-tasks-mcp.mjs", import.meta.url).pathname], {
    env: { ...process.env, PAPERCLIP_API_URL: `http://127.0.0.1:${server.address().port}`, PAPERCLIP_COMPANY_ID: "company", PAPERCLIP_API_KEY: "test" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout });
  t.after(() => { lines.close(); child.kill(); server.close(); server.closeAllConnections(); });
  let id = 0;
  const call = async (name, args) => {
    const response = once(lines, "line");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    const { result } = JSON.parse((await response)[0]);
    return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text);
  };
  const report = "# Incident report\n\n" + "A line of the report.\n".repeat(12_000);
  const done = await call("task_attach", { issue: "PEN-3", name: "report.md", content: report });
  assert.deepEqual(done, { file: "new", name: "report.md", bytes: Buffer.byteLength(report), replaced: true });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].issue, "ursula");
  assert.match(uploads[0].type, /^multipart\/form-data/);
  assert.match(uploads[0].body, /filename="report\.md"\r\nContent-Type: text\/markdown/);
  assert.ok(uploads[0].body.includes(report), "the whole draft, not a part of it");
  assert.deepEqual(deleted, ["old"], "the earlier version goes once the new one is there");
  assert.match((await call("task_attach", { issue: "PEN-2", name: "report.md", content: "x" })).error, /only be attached to your own part/);
  assert.match((await call("task_attach", { issue: "PEN-3", name: "../x.sh", content: "x" })).error, /name the file like report\.md/);
  assert.equal(uploads.length, 1);
});
