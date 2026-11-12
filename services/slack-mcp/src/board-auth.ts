import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { AUTHORIZE_ENDPOINT, TOKEN_ENDPOINT, READ_SCOPES, parseTokenResponse, TokenStore } from "./tokens.js";

export class BoardSignInError extends Error {}

export function slackSignInError(code: unknown): BoardSignInError {
  const key = typeof code === "string" && /^[a-z_]{1,80}$/.test(code) ? code : "oauth_error";
  const hints: Record<string, string> = {
    bad_client_secret: "Enable PKCE in the Slack app's OAuth & Permissions, then start a new sign-in.",
    invalid_client: "Check the saved Client ID and enable PKCE in the Slack app's OAuth & Permissions.",
    invalid_client_id: "Check that the saved Client ID belongs to your Manor Slack app.",
    invalid_code: "The authorization code is invalid or expired. Start a new sign-in and paste the complete final URL promptly.",
    code_already_used: "This authorization code was already used. Start a new sign-in.",
    bad_redirect_uri: "Register http://localhost:3118/callback exactly in the Slack app, then start again.",
    invalid_code_verifier: "The PKCE verifier was rejected. Start a new sign-in from this browser.",
    access_denied: "Slack denied access. Check workspace app approval and try again.",
  };
  return new BoardSignInError(`Slack returned ${key}. ${hints[key] ?? "Check the Slack app configuration and start a new sign-in."}`);
}

/** Separate board credential; neither MCP audience can start or finish sign-ins. */
export class BoardAuth {
  private pending = new Map<string, { verifier: string; expires: number }>();
  constructor(private clientId: string, private tokens: TokenStore, private fetchImpl: typeof fetch = fetch, private configPath?: string) {
    if (!this.clientId && configPath && existsSync(configPath)) {
      this.clientId = JSON.parse(readFileSync(configPath, "utf8")).client_id;
      this.tokens.setClientId(this.clientId);
    }
  }
  configure(clientId: string) {
    if (this.clientId || !this.configPath) throw new Error("Client already configured or configuration unavailable");
    writeFileSync(this.configPath, JSON.stringify({ client_id: clientId }), { mode: 0o600 });
    this.clientId = clientId; this.tokens.setClientId(clientId);
    return { configured: true };
  }
  status() { return { configured: Boolean(this.clientId), connected: this.tokens.available() }; }
  start() {
    if (!this.clientId) throw new Error("Set SLACK_CLIENT_ID for your workspace and restart Slack before connecting.");
    for (const [s, p] of this.pending) if (p.expires < Date.now()) this.pending.delete(s);
    if (this.pending.size >= 20) throw new Error("Too many pending sign-ins; try again in ten minutes.");
    const state = randomBytes(24).toString("base64url"), verifier = randomBytes(48).toString("base64url");
    this.pending.set(state, { verifier, expires: Date.now() + 600_000 });
    const url = new URL(AUTHORIZE_ENDPOINT);
    url.search = new URLSearchParams({ client_id: this.clientId, redirect_uri: "http://localhost:3118/callback", response_type: "code", scope: READ_SCOPES.join(","), state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
    return { url: url.toString() };
  }
  async finish(state: string, code: string) {
    const p = this.pending.get(state); this.pending.delete(state);
    if (!p || p.expires < Date.now()) throw new BoardSignInError("Sign-in expired or already used. Start again.");
    const body = new URLSearchParams({ client_id: this.clientId, redirect_uri: "http://localhost:3118/callback", grant_type: "authorization_code", code, code_verifier: p.verifier });
    let response: Response;
    try { response = await this.fetchImpl(TOKEN_ENDPOINT, { method: "POST", body, signal: AbortSignal.timeout(15_000) }); }
    catch { throw new BoardSignInError("Could not reach Slack's token endpoint. Start a new sign-in and try again."); }
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || data.ok === false) throw slackSignInError(data.error);
    let token;
    try { token = parseTokenResponse(data); }
    catch { throw new BoardSignInError("Slack did not return a usable access token. Start a new sign-in."); }
    try { this.tokens.install(token); }
    catch { throw new BoardSignInError("Slack approved access, but Manor could not save it. Check the Slack state directory permissions on the server."); }
    return { connected: true };
  }
}
