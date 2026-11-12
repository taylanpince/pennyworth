import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

test("WhatsApp source markers create user tasks and deduplicate closed tasks", async (t) => {
  const tasks = [];
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const task = { ...JSON.parse(body), id: String(tasks.length + 1) };
      tasks.push(task);
      res.end(JSON.stringify(task));
    } else if (req.url.includes("/issues?")) {
      const url = new URL(req.url, "http://localhost");
      res.end(JSON.stringify(tasks.filter((task) =>
        task.description.includes(url.searchParams.get("q")) &&
        url.searchParams.get("status").split(",").includes(task.status))));
    } else {
      res.end(JSON.stringify(req.url.endsWith("/labels") ? [] : { defaultResponsibleUserId: "owner" }));
    }
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
  async function create(marker, related_markers = []) {
    const response = once(lines, "line");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: {
      name: "task_create", arguments: { title: "Pinned message", description: "Follow up", marker, related_markers, dedupe_closed: true },
    } }) + "\n");
    return JSON.parse((await response)[0]).result;
  }
  for (const chat of ["123@g.us", "456@s.whatsapp.net", "789@lid"]) {
    const marker = `source:whatsapp:${chat}:ABC123`;
    const result = await create(marker, [marker]);
    assert.equal(result.isError, undefined);
    const task = tasks.at(-1);
    assert.equal(task.assigneeUserId, "owner");
    assert.ok(task.description.includes(`<!-- source:${marker} -->`));
    task.status = "done";
    const replay = await create(marker);
    assert.equal(JSON.parse(replay.content[0].text).deduplicated, true);
  }
  assert.equal(tasks.length, 3);
  for (const marker of ["source:bad -->", "source:bad\nvalue", "x".repeat(201)]) {
    assert.equal((await create(marker)).isError, true);
  }
  assert.equal((await create("source:valid", ["bad -->"])).isError, true);
  assert.equal(tasks.length, 3);
});
