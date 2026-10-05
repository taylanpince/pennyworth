// Host-side, one-time OAuth consent for the read-only Google sidecar.
//
//   node src/auth.ts <client_secret.json> <credentials file> [--email you@example.com] [--primary]
//
// Adds (or refreshes) one Google account in the multi-account credentials file. --email
// pre-selects the account in Google's chooser; --primary makes it the account used for
// Calendar and meeting documents (the first account is primary by default).
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

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const loginHint = flag("--email");
const makePrimary = args.includes("--primary");
if (makePrimary) args.splice(args.indexOf("--primary"), 1);
const [clientFile, outFile] = args;
if (!clientFile || !outFile) {
  console.error("usage: node src/auth.ts <client_secret.json> <credentials file> [--email you@example.com] [--primary]");
  process.exit(2);
}

type Account = { refresh_token: string; scopes?: string[] };
type CredsFile = { client_id?: string; client_secret?: string; refresh_token?: string; primary?: string; accounts?: Record<string, Account> };

async function emailFor(accessToken: string): Promise<string> {
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${accessToken}` } });
  const j = (await r.json()) as { emailAddress?: string };
  if (!j.emailAddress) throw new Error("could not determine the account's email address (is the Gmail API enabled?)");
  return j.emailAddress;
}

/** Existing credentials, converting the legacy single-account shape (its email is looked up). */
async function existingCreds(clientId: string, clientSecret?: string): Promise<CredsFile> {
  let current: CredsFile = {};
  try {
    current = JSON.parse(readFileSync(outFile as string, "utf8")) as CredsFile;
  } catch {
    return {};
  }
  if (current.refresh_token && !current.accounts) {
    try {
      const body = new URLSearchParams({ client_id: current.client_id ?? clientId, refresh_token: current.refresh_token, grant_type: "refresh_token" });
      if (current.client_secret ?? clientSecret) body.set("client_secret", (current.client_secret ?? clientSecret)!);
      const tok = (await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", body })).json()) as { access_token?: string };
      if (tok.access_token) {
        const email = await emailFor(tok.access_token);
        current = { client_id: current.client_id, client_secret: current.client_secret, primary: email, accounts: { [email]: { refresh_token: current.refresh_token } } };
        console.log(`Converted the existing login (${email}) to the multi-account format.`);
      }
    } catch {
      current = {};
    }
  }
  return current;
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
  const tokens = (await tokenRes.json()) as { refresh_token?: string; access_token?: string; scope?: string; error?: string };
  if (!tokenRes.ok || !tokens.refresh_token) {
    res.writeHead(500).end("token exchange failed; see terminal");
    console.error("token exchange failed:", tokens.error ?? tokenRes.status);
    process.exit(1);
  }
  const granted = (tokens.scope ?? "").split(" ");
  const unexpected = granted.filter((s) => s && !SCOPES.includes(s) && !["openid", "email", "profile"].includes(s));
  if (unexpected.length) console.warn("warning: unexpected scopes granted:", unexpected.join(", "));
  const email = await emailFor(tokens.access_token!);
  const creds = await existingCreds(client.client_id, client.client_secret);
  creds.client_id = client.client_id;
  creds.client_secret = client.client_secret;
  creds.accounts = { ...(creds.accounts ?? {}), [email]: { refresh_token: tokens.refresh_token, scopes: granted } };
  if (makePrimary || !creds.primary) creds.primary = email;
  delete creds.refresh_token;
  writeFileSync(outFile, JSON.stringify(creds, null, 2), { mode: 0o600 });
  chmodSync(outFile, 0o600);
  res.writeHead(200, { "content-type": "text/plain" }).end(`Pennyworth: read-only access granted for ${email}. You can close this tab.`);
  console.log(`Connected ${email} (read-only). Accounts: ${Object.keys(creds.accounts).join(", ")}; primary (Calendar, meeting docs): ${creds.primary}`);
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
    ...(loginHint ? { login_hint: loginHint } : {}),
  }).toString();
  console.log("Open this URL in your browser and approve read-only access:\n");
  console.log(auth.toString());
});
