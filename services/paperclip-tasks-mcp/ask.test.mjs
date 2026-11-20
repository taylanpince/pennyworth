import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

test("task_ask posts a question card the board turns into buttons", async (t) => {
  const posted = [];
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method === "POST" && req.url.endsWith("/comments")) {
      posted.push(JSON.parse(body).body);
      return res.end(JSON.stringify({ id: `c${posted.length}` }));
    }
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
  async function call(name, args) {
    const response = once(lines, "line");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    return JSON.parse((await response)[0]).result;
  }
  const ok = await call("task_ask", { issue: "PEN-1", question: "Which tone?", options: ["Formal", "Plain --> friendly"], recommended: 2 });
  assert.equal(ok.isError, undefined);
  assert.match(posted[0], /^\*\*Question:\*\* Which tone\?\n\n1\. Formal\n2\. Plain --> friendly _\(recommended\)_\n/);
  const card = /<!-- pennyworth-ask (\{.*\}) -->$/.exec(posted[0])[1];
  assert.ok(!card.includes("--"), "nothing in the marker ends the comment early");
  assert.deepEqual(JSON.parse(card), { options: ["Formal", "Plain --> friendly"], recommended: 1 });
  assert.equal((await call("task_ask", { issue: "PEN-1", question: "x", options: ["a"], recommended: 3 })).isError, true);
  assert.equal((await call("task_ask", { issue: "PEN-1", question: "" })).isError, true);
  assert.equal(posted.length, 1);
});
