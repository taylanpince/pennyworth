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
