// Host-side, one-time OAuth consent for the read-only Google sidecar.
//
//   node src/auth.ts <client_secret.json> <output credentials file>
//
// Uses the installed-app loopback flow with PKCE. Requests read-only scopes only.
// Self-contained (no local imports) so it runs with Node's type stripping.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
];

const [clientFile, outFile] = process.argv.slice(2);
if (!clientFile || !outFile) {
  console.error("usage: node src/auth.ts <client_secret.json> <output credentials file>");
  process.exit(2);
}

const raw = JSON.parse(readFileSync(clientFile, "utf8"));
const client = raw.installed ?? raw.web ?? raw;
if (!client.client_id) throw new Error("client file has no client_id (download a 'Desktop app' OAuth client JSON)");

const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/callback") return void res.writeHead(404).end();
  if (url.searchParams.get("state") !== state) return void res.writeHead(400).end("state mismatch");
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end(`authorization failed: ${url.searchParams.get("error")}`);
    process.exit(1);
  }
  const body = new URLSearchParams({
    code,
    client_id: client.client_id,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (client.client_secret) body.set("client_secret", client.client_secret);
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const tokens = (await tokenRes.json()) as { refresh_token?: string; scope?: string; error?: string };
  if (!tokenRes.ok || !tokens.refresh_token) {
    res.writeHead(500).end("token exchange failed; see terminal");
    console.error("token exchange failed:", tokens.error ?? tokenRes.status);
    process.exit(1);
  }
  const granted = (tokens.scope ?? "").split(" ");
  const unexpected = granted.filter((s) => s && !SCOPES.includes(s) && !["openid", "email", "profile"].includes(s));
  if (unexpected.length) console.warn("warning: unexpected scopes granted:", unexpected.join(", "));
  writeFileSync(outFile, JSON.stringify({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: tokens.refresh_token, scopes: granted }, null, 2), { mode: 0o600 });
  chmodSync(outFile, 0o600);
  res.writeHead(200, { "content-type": "text/plain" }).end("Pennyworth: Google read-only access granted. You can close this tab.");
  console.log(`Saved read-only credentials to ${outFile}`);
  server.close();
});

let redirectUri = "";
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  redirectUri = `http://127.0.0.1:${port}/callback`;
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();
  console.log("Open this URL in your browser and approve read-only access:\n");
  console.log(auth.toString());
});
