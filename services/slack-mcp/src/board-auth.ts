import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { AUTHORIZE_ENDPOINT, TOKEN_ENDPOINT, READ_SCOPES, parseTokenResponse, TokenStore } from "./tokens.js";

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
    if (!p || p.expires < Date.now()) throw new Error("Sign-in expired or already used. Start again.");
    const body = new URLSearchParams({ client_id: this.clientId, redirect_uri: "http://localhost:3118/callback", grant_type: "authorization_code", code, code_verifier: p.verifier });
    const response = await this.fetchImpl(TOKEN_ENDPOINT, { method: "POST", body, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("Slack refused the sign-in. Start again.");
    const token = parseTokenResponse(await response.json() as Record<string, unknown>);
    this.tokens.install(token);
    return { connected: true };
  }
}
