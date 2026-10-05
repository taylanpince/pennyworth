// Host-side, one-time Slack consent for the read-only Slack sidecar.
//
//   node src/auth.ts <client_id> <output token file> [callback_port]
//
// OAuth 2 authorization code flow with PKCE against Slack's MCP OAuth endpoints, using
// the organisation's pre-registered public client and its registered loopback callback.
// Requests read and search scopes only. Self-contained so it runs with type stripping.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const AUTHORIZE = "https://slack.com/oauth/v2_user/authorize";
const TOKEN = "https://slack.com/api/oauth.v2.user.access";
const SCOPES = [
  "search:read.public", "search:read.private", "search:read.im", "search:read.mpim", "search:read.users",
  "channels:history", "channels:read", "groups:history", "groups:read",
  "im:history", "im:read", "mpim:history", "mpim:read", "users:read",
];

const [clientId, outFile, portArg = "3118"] = process.argv.slice(2);
if (!clientId || !outFile) {
  console.error("usage: node src/auth.ts <client_id> <output token file> [callback_port]");
  process.exit(2);
}
const port = Number(portArg);
const redirectUri = `http://localhost:${port}/callback`;
const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname !== "/callback") return void res.writeHead(404).end();
  if (url.searchParams.get("state") !== state) return void res.writeHead(400).end("state mismatch");
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end(`authorization failed: ${url.searchParams.get("error")}`);
    console.error("authorization failed:", url.searchParams.get("error"));
    process.exit(1);
  }
  const body = new URLSearchParams({ code, client_id: clientId, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri });
  const tokenRes = await fetch(TOKEN, { method: "POST", body });
  const json = (await tokenRes.json()) as Record<string, any>;
  const src = json.authed_user?.access_token ? json.authed_user : json;
  if (json.ok === false || !src.access_token) {
    res.writeHead(500).end("token exchange failed; see terminal");
    console.error("token exchange failed:", json.error ?? tokenRes.status);
    process.exit(1);
  }
  const granted = String(src.scope ?? "").split(/[ ,]+/).filter(Boolean);
  const writes = granted.filter((s) => /:write|^chat:/.test(s));
  if (writes.length) console.warn(`warning: Slack granted write scopes (${writes.join(", ")}); the sidecar still exposes read tools only.`);
  const expiresIn = Number(src.expires_in ?? json.expires_in);
  const token = {
    access_token: src.access_token,
    refresh_token: src.refresh_token,
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    scope: granted.join(" "),
    user_id: src.id ?? json.user_id,
    team_id: json.team?.id,
  };
  writeFileSync(outFile, JSON.stringify(token, null, 2), { mode: 0o600 });
  chmodSync(outFile, 0o600);
  res.writeHead(200, { "content-type": "text/plain" }).end("Pennyworth: Slack read-only access granted. You can close this tab.");
  console.log(`Saved Slack token for user ${token.user_id ?? "?"} (scopes: ${granted.length}) to ${outFile}`);
  server.close();
});

server.on("error", (err) => {
  console.error(`cannot listen on localhost:${port} (${(err as Error).message}). Close anything using it, e.g. a Claude Code Slack login, and retry.`);
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  const auth = new URL(AUTHORIZE);
  auth.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(","),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();
  console.log("Open this URL in your browser and approve read-only Slack access:\n");
  console.log(auth.toString());
});
