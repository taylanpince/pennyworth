// Host-side, one-time consent for the read-only Telegram sidecar.
//
//   TELEGRAM_MCP_URL=https://…/mcp node src/auth.ts <output token file> [callback_port]
//
// The Telegram MCP server is an OAuth 2.1 server with dynamic client registration: this
// registers Pennyworth as a public client with a loopback callback, then runs the
// authorization code flow with PKCE (sign-in, Telegram linking and the chat picker happen
// on the server's pages). Self-contained so it runs with type stripping.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const SERVER = (process.env.TELEGRAM_MCP_URL ?? "").replace(/\/$/, "");
const [outFile, portArg = "3119"] = process.argv.slice(2);
if (!outFile || !SERVER) {
  console.error("usage: TELEGRAM_MCP_URL=https://…/mcp node src/auth.ts <output token file> [callback_port]");
  process.exit(2);
}
const port = Number(portArg);
const redirectUri = `http://localhost:${port}/callback`;

const origin = new URL(SERVER).origin;
const meta = (await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>;
const reg = await fetch(meta.registration_endpoint!, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "Pennyworth (read-only)",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }),
});
const client = (await reg.json()) as Record<string, string>;
if (!reg.ok || !client.client_id) {
  console.error("client registration failed:", reg.status, JSON.stringify(client).slice(0, 300));
  process.exit(1);
}

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
    console.error("authorization failed:", url.searchParams.get("error"), url.searchParams.get("error_description") ?? "");
    process.exit(1);
  }
  const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.client_id!, code_verifier: verifier, redirect_uri: redirectUri, resource: SERVER });
  const tokenRes = await fetch(meta.token_endpoint!, { method: "POST", body });
  const json = (await tokenRes.json()) as Record<string, any>;
  if (!tokenRes.ok || !json.access_token) {
    res.writeHead(500).end("token exchange failed; see terminal");
    console.error("token exchange failed:", json.error ?? tokenRes.status, json.error_description ?? "");
    process.exit(1);
  }
  const expiresIn = Number(json.expires_in);
  const token = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    scope: json.scope,
    client_id: client.client_id,
    token_endpoint: meta.token_endpoint,
    resource: SERVER,
  };
  writeFileSync(outFile, JSON.stringify(token, null, 2), { mode: 0o600 });
  chmodSync(outFile, 0o600);
  res.writeHead(200, { "content-type": "text/plain" }).end("Pennyworth: Telegram read-only access granted. You can close this tab.");
  console.log(`Saved Telegram MCP token${token.refresh_token ? " (with refresh token)" : " (NO refresh token: it will need re-consent when it expires)"} to ${outFile}`);
  server.close();
});

server.on("error", (err) => {
  console.error(`cannot listen on localhost:${port} (${(err as Error).message}). Free the port or pass another one, and retry.`);
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  const auth = new URL(meta.authorization_endpoint!);
  auth.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id!,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource: SERVER,
  }).toString();
  console.log("Open this URL in your browser, sign in, and approve read-only Telegram access:\n");
  console.log(auth.toString());
});
