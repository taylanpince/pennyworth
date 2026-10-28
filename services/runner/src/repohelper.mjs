// The agent's `pennyworth` commands (bin/pennyworth, and bin/pennyworth-repo): a loopback endpoint in
// the runner. `repo` clones another repository into the job's workspace (D-41): agents have no SSH
// agent, so they can't clone private repositories themselves. `status`, `push`, `pr` and `merge`
// are the runner's GitHub actions as the agent's tools (stage 2 of docs/design/conversational-engineers.md);
// the runner checks each against the user's words. Each job gets its own random token.

/** The commands, and nothing else: verify-security.sh checks this list. */
export const TOOLS = ["repo", "status", "push", "pr", "merge"];
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

/**
 * `clone(ctx, repo)` for `repo`, and `tools[name](ctx, args)` for the others: each resolves with the
 * text to print, or rejects with a message for the agent.
 */
export function startRepoHelper(clone, log = () => {}, tools = {}) {
  const jobs = new Map(); // token → job context
  const server = createServer(async (req, res) => {
    const reply = (code, text) => res.writeHead(code, { "content-type": "text/plain; charset=utf-8" }).end(text);
    const name = String(req.url ?? "").slice(1);
    if (req.method !== "POST" || !TOOLS.includes(name) || (name !== "repo" && !tools[name])) return reply(404, "not found");
    const ctx = jobs.get(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    if (!ctx) return reply(401, "this task run is over");
    let body;
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8").slice(0, 65_536));
    } catch {
      return reply(400, name === "repo" ? "send {\"repo\": \"org/name\"}" : "send a JSON object");
    }
    try {
      reply(200, name === "repo" ? await clone(ctx, String(body?.repo ?? "")) : await tools[name](ctx, body ?? {}));
    } catch (err) {
      log(`${name} refused`, { issue: ctx.issue?.identifier, err: String(err.message ?? err).slice(0, 300) });
      reply(400, String(err.message ?? err).slice(0, 2000));
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
