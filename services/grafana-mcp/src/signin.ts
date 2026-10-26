import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { SCOPES } from "./policy.js";
import type { TokenStore } from "./tokens.js";

interface Metadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  redirect_uri: string;
  issuer: string;
}

export class SignInError extends Error {}

/**
 * Signing Pennyworth in to Grafana's hosted MCP server, started from the board (like Glean, D-38):
 * OAuth 2.1 with PKCE, the client registered dynamically once per redirect address and kept in
 * /state. Only SCOPES are requested (read and query, never write). The browser comes back to the
 * board's loopback address, which hands the code to finish(). Only this service sees the tokens.
 */
export class SignIn {
  private readonly pending = new Map<string, { verifier: string; redirectUri: string; meta: Metadata; client: RegisteredClient; expires: number }>();

  constructor(
    private readonly mcpUrl: string,
    private readonly grafanaUrl: string,
    private readonly clientPath: string,
    private readonly tokens: TokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  private async json(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    const res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
    return { ok: res.ok, status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  /**
   * The authorization server for this Grafana stack. The MCP server serves one per stack: its 401
   * names the stack's resource metadata (RFC 9728, `/mcp/gurl/<stack>`), whose issuer's metadata
   * (RFC 8414) carries an authorization endpoint with the stack's grafana_url.
   */
  async discover(): Promise<{ issuer: string; meta: Metadata; scopes: string[] }> {
    const probe = await this.fetchImpl(this.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-grafana-url": this.grafanaUrl },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      signal: AbortSignal.timeout(15_000),
    });
    const resourceMetadata = /resource_metadata="([^"]+)"/.exec(probe.headers.get("www-authenticate") ?? "")?.[1];
    if (!resourceMetadata) throw new SignInError(`Grafana's MCP server didn't name its sign-in server (answered ${probe.status})`);
    const r = await this.json(resourceMetadata);
    const servers = r.ok ? r.body.authorization_servers : undefined;
    if (!Array.isArray(servers) || typeof servers[0] !== "string") throw new SignInError("Grafana's resource metadata has no authorization server");
    const issuer = servers[0].replace(/\/$/, "");
    const is = new URL(issuer);
    const m = await this.json(`${is.origin}/.well-known/oauth-authorization-server${is.pathname.replace(/\/$/, "")}`);
    if (!m.ok || typeof m.body.authorization_endpoint !== "string" || typeof m.body.token_endpoint !== "string") throw new SignInError(`couldn't find Grafana's sign-in server for ${this.grafanaUrl}`);
    const meta = m.body as unknown as Metadata;
    // Without offline_access there may be no refresh token; Grafana doesn't list it today.
    const scopes = Array.isArray(meta.scopes_supported) && meta.scopes_supported.includes("offline_access") ? [...SCOPES, "offline_access"] : [...SCOPES];
    return { issuer, meta, scopes };
  }

  private async client(issuer: string, meta: Metadata, redirectUri: string): Promise<RegisteredClient> {
    const saved = existsSync(this.clientPath) ? (JSON.parse(readFileSync(this.clientPath, "utf8")) as RegisteredClient) : undefined;
    if (saved?.client_id && saved.redirect_uri === redirectUri && saved.issuer === issuer) return saved;
    if (!meta.registration_endpoint) throw new SignInError("Grafana doesn't offer client registration");
    const r = await this.json(meta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Pennyworth", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    if (!r.ok || typeof r.body.client_id !== "string") throw new SignInError(`Grafana refused to register Pennyworth (${String(r.body.error_description ?? r.body.error ?? r.status).slice(0, 200)})`);
    const client: RegisteredClient = { client_id: r.body.client_id, ...(typeof r.body.client_secret === "string" ? { client_secret: r.body.client_secret } : {}), redirect_uri: redirectUri, issuer };
    writeFileSync(this.clientPath, JSON.stringify(client, null, 2), { mode: 0o600 });
    chmodSync(this.clientPath, 0o600);
    return client;
  }

  /** Grafana's sign-in URL; Grafana sends the browser back to `redirectUri` (the board's loopback address). */
  async start(redirectUri: string): Promise<{ url: string }> {
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[\w/-]*$/.test(redirectUri)) throw new SignInError("redirect must be a loopback address");
    const { issuer, meta, scopes } = await this.discover();
    const client = await this.client(issuer, meta, redirectUri);
    const now = Date.now();
    for (const [k, p] of this.pending) if (p.expires < now) this.pending.delete(k);
    const verifier = randomBytes(48).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    this.pending.set(state, { verifier, redirectUri, meta, client, expires: now + this.ttlMs });
    // The endpoint already names the stack (?grafana_url=…): add to its query, don't replace it.
    const url = new URL(meta.authorization_endpoint);
    const params = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state,
      resource: this.mcpUrl,
      scope: scopes.join(" "),
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return { url: url.toString() };
  }

  async finish(state: string, code: string): Promise<void> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.expires < Date.now()) throw new SignInError("this sign-in link expired or was already used; start again from the board");
    const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: p.client.client_id, code_verifier: p.verifier, redirect_uri: p.redirectUri, resource: this.mcpUrl });
    if (p.client.client_secret) body.set("client_secret", p.client.client_secret);
    const r = await this.json(p.meta.token_endpoint, { method: "POST", body });
    const access = r.body.access_token;
    if (!r.ok || typeof access !== "string") throw new SignInError(`Grafana refused the sign-in: ${String(r.body.error ?? r.status)}`);
    const granted = typeof r.body.scope === "string" ? r.body.scope : undefined;
    if (granted && /grafana:write/.test(granted)) throw new SignInError("Grafana granted write access, which Pennyworth never asks for; sign-in refused");
    const expiresIn = Number(r.body.expires_in);
    this.tokens.replace({
      access_token: access,
      ...(typeof r.body.refresh_token === "string" ? { refresh_token: r.body.refresh_token } : {}),
      ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expires_at: Date.now() + expiresIn * 1000 } : {}),
      ...(granted ? { scope: granted } : {}),
      client_id: p.client.client_id,
      ...(p.client.client_secret ? { client_secret: p.client.client_secret } : {}),
      token_endpoint: p.meta.token_endpoint,
      resource: this.mcpUrl,
    });
  }
}
