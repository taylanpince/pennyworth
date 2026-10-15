// The agent's `pennyworth-repo <org/name>` (bin/pennyworth-repo): a loopback endpoint in the runner
// that clones another repository into the job's workspace (D-41). Agents have no SSH agent, so they
// can't clone private repositories themselves. Each job gets its own random token.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

/** `clone(ctx, repo)` resolves with the text to print, or rejects with a message for the agent. */
export function startRepoHelper(clone, log = () => {}) {
  const jobs = new Map(); // token → job context
  const server = createServer(async (req, res) => {
    const reply = (code, text) => res.writeHead(code, { "content-type": "text/plain; charset=utf-8" }).end(text);
    if (req.method !== "POST" || req.url !== "/repo") return reply(404, "not found");
    const ctx = jobs.get(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    if (!ctx) return reply(401, "this task run is over");
    let body;
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8").slice(0, 4096));
    } catch {
      return reply(400, "send {\"repo\": \"org/name\"}");
    }
    try {
      reply(200, await clone(ctx, String(body?.repo ?? "")));
    } catch (err) {
      log("repo helper refused", { repo: String(body?.repo ?? "").slice(0, 100), err: String(err.message ?? err).slice(0, 200) });
      reply(400, String(err.message ?? err).slice(0, 500));
    }
  });
  server.listen(0, "127.0.0.1");
  server.unref();
  return {
    url: () => `http://127.0.0.1:${server.address().port}`,
    /** Allow one job to use the helper until `done()`; returns the environment for its agent. */
    register(ctx) {
      const token = randomBytes(24).toString("hex");
      jobs.set(token, ctx);
      return { env: { PENNYWORTH_REPO_URL: `http://127.0.0.1:${server.address().port}`, PENNYWORTH_REPO_TOKEN: token }, done: () => jobs.delete(token) };
    },
    close: () => server.close(),
  };
}
