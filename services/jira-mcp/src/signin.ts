import { createHash, randomBytes } from "node:crypto";

import type { TokenStore } from "./tokens.js";

/**
 * The OAuth scopes Pennyworth asks Jira for: read and write on Jira issues, the user list for
 * names, and a refresh token. Atlassian's MCP server also serves Confluence and Bitbucket; nothing
 * of those is ever requested. A sign-in that comes back with anything else is refused.
 */
export const SCOPES = ["read:jira-user", "read:jira-work", "write:jira-work", "offline_access"] as const;

/** Atlassian offers no dynamic client registration: the client is a 3LO app registered by hand
 * (developer.atlassian.com/console), its id in .env, like Slack's connector. */
const AUTHORIZE = "https://auth.atlassian.com/authorize";
const TOKEN = "https://auth.atlassian.com/oauth/token";

export class SignInError extends Error {}

export class SignIn {
  private readonly pending = new Map<string, { verifier: string; redirectUri: string; expires: number }>();

  constructor(
    private readonly clientId: string,
    private readonly tokens: TokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  /** Jira's sign-in URL; Atlassian sends the browser back to `redirectUri` (the board's loopback address). */
  async start(redirectUri: string): Promise<{ url: string }> {
    if (!this.clientId) throw new SignInError("no Atlassian client (set ATLASSIAN_CLIENT_ID in .env: register an OAuth 2.0 app at developer.atlassian.com/console)");
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[\w/-]*$/.test(redirectUri)) throw new SignInError("redirect must be a loopback address");
    const now = Date.now();
    for (const [k, p] of this.pending) if (p.expires < now) this.pending.delete(k);
    const verifier = randomBytes(48).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    this.pending.set(state, { verifier, redirectUri, expires: now + this.ttlMs });
    const url = new URL(AUTHORIZE);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state,
      // audience: Atlassian's 3LO requires it; prompt: a consent every time, so the account is a choice.
      audience: "api.atlassian.com",
      prompt: "consent",
      scope: SCOPES.join(" "),
    }))
      url.searchParams.set(k, v);
    return { url: url.toString() };
  }

  async finish(state: string, code: string): Promise<void> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.expires < Date.now()) throw new SignInError("this sign-in link expired or was already used; start again from the board");
    const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: this.clientId, code_verifier: p.verifier, redirect_uri: p.redirectUri });
    const { token, granted } = await this.exchange(body);
    this.tokens.replace({ ...token, client_id: this.clientId, token_endpoint: TOKEN });
  }

  /** One place for token responses: what came back must stay inside the scopes Pennyworth asked for. */
  private async exchange(body: URLSearchParams): Promise<{ token: { access_token: string; refresh_token?: string; expires_at?: number; scope?: string }; granted: Set<string> }> {
    const res = await this.fetchImpl(TOKEN, { method: "POST", body, signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const access = json.access_token;
    if (!res.ok || typeof access !== "string" || !access) throw new SignInError(`Atlassian refused the sign-in: ${String(json.error_description ?? json.error ?? res.status).slice(0, 200)}`);
    const granted = new Set((typeof json.scope === "string" ? json.scope : "").split(/\s+/).filter(Boolean));
    const extra = [...granted].filter((s) => !(SCOPES as readonly string[]).includes(s));
    if (extra.length) throw new SignInError(`Atlassian granted more than Pennyworth asks for (${extra.join(", ")}); sign-in refused`);
    const expiresIn = Number(json.expires_in);
    return {
      token: {
        access_token: access,
        ...(typeof json.refresh_token === "string" ? { refresh_token: json.refresh_token } : {}),
        ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expires_at: Date.now() + expiresIn * 1000 } : {}),
        ...(granted.size ? { scope: [...granted].join(" ") } : {}),
      },
      granted,
    };
  }
}
