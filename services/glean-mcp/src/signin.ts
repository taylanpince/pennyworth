import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { TokenStore } from "./tokens.js";

interface Metadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  redirect_uri: string;
  issuer: string;
}

export class SignInError extends Error {}

/**
 * Signing Pennyworth in to Glean's MCP server, started from the board (like Google's Reconnect, D-36):
 * OAuth 2.1 with PKCE, the client registered dynamically once per redirect address and kept in
 * /state. The browser comes back to the board's loopback address, which hands the code to finish().
 * Only this service sees the tokens.
 */
export class SignIn {
  private readonly pending = new Map<string, { verifier: string; redirectUri: string; meta: Metadata; client: RegisteredClient; expires: number }>();

  constructor(
    private readonly mcpUrl: string,
    private readonly clientPath: string,
    private readonly tokens: TokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  private async json(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    const res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
    return { ok: res.ok, status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  /** The authorization server for the MCP endpoint (RFC 9728 resource metadata, then RFC 8414). */
  async discover(): Promise<{ issuer: string; meta: Metadata; scopes?: string[] }> {
    const mcp = new URL(this.mcpUrl);
    let issuer = mcp.origin;
    let scopes: string[] | undefined;
    for (const u of [`${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname.replace(/\/$/, "")}`, `${mcp.origin}/.well-known/oauth-protected-resource`]) {
      const r = await this.json(u).catch(() => undefined);
      const servers = r?.ok ? r.body.authorization_servers : undefined;
      if (Array.isArray(servers) && typeof servers[0] === "string") {
        issuer = servers[0].replace(/\/$/, "");
        if (Array.isArray(r!.body.scopes_supported)) scopes = (r!.body.scopes_supported as unknown[]).filter((s): s is string => typeof s === "string");
        break;
      }
    }
    const is = new URL(issuer);
    const path = is.pathname.replace(/\/$/, "");
    for (const u of [`${is.origin}/.well-known/oauth-authorization-server${path}`, `${is.origin}${path}/.well-known/openid-configuration`, `${is.origin}/.well-known/oauth-authorization-server`]) {
      const r = await this.json(u).catch(() => undefined);
      if (r?.ok && typeof r.body.authorization_endpoint === "string" && typeof r.body.token_endpoint === "string") {
        return { issuer, meta: r.body as unknown as Metadata, ...(scopes?.length ? { scopes } : {}) };
      }
    }
    throw new SignInError(`couldn't find Glean's sign-in server for ${this.mcpUrl}`);
  }

  private async client(issuer: string, meta: Metadata, redirectUri: string): Promise<RegisteredClient> {
    const saved = existsSync(this.clientPath) ? (JSON.parse(readFileSync(this.clientPath, "utf8")) as RegisteredClient) : undefined;
    if (saved?.client_id && saved.redirect_uri === redirectUri && saved.issuer === issuer) return saved;
    if (!meta.registration_endpoint) throw new SignInError("Glean doesn't offer client registration (ask an admin to enable the OAuth authorization server)");
    const r = await this.json(meta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Pennyworth", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    if (!r.ok || typeof r.body.client_id !== "string") throw new SignInError(`Glean refused to register Pennyworth (${String(r.body.error_description ?? r.body.error ?? r.status).slice(0, 200)})`);
    const client: RegisteredClient = { client_id: r.body.client_id, ...(typeof r.body.client_secret === "string" ? { client_secret: r.body.client_secret } : {}), redirect_uri: redirectUri, issuer };
    writeFileSync(this.clientPath, JSON.stringify(client, null, 2), { mode: 0o600 });
    chmodSync(this.clientPath, 0o600);
    return client;
  }

  /** Glean's sign-in URL; Glean sends the browser back to `redirectUri` (the board's loopback address). */
  async start(redirectUri: string): Promise<{ url: string }> {
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/[\w/-]*$/.test(redirectUri)) throw new SignInError("redirect must be a loopback address");
    const { issuer, meta, scopes } = await this.discover();
    const client = await this.client(issuer, meta, redirectUri);
    const now = Date.now();
    for (const [k, p] of this.pending) if (p.expires < now) this.pending.delete(k);
    const verifier = randomBytes(48).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    this.pending.set(state, { verifier, redirectUri, meta, client, expires: now + this.ttlMs });
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state,
      resource: this.mcpUrl,
      ...(scopes ? { scope: scopes.join(" ") } : {}),
    }).toString();
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
    if (!r.ok || typeof access !== "string") throw new SignInError(`Glean refused the sign-in: ${String(r.body.error ?? r.status)}`);
    const expiresIn = Number(r.body.expires_in);
    this.tokens.replace({
      access_token: access,
      ...(typeof r.body.refresh_token === "string" ? { refresh_token: r.body.refresh_token } : {}),
      ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expires_at: Date.now() + expiresIn * 1000 } : {}),
      ...(typeof r.body.scope === "string" ? { scope: r.body.scope } : {}),
      client_id: p.client.client_id,
      ...(p.client.client_secret ? { client_secret: p.client.client_secret } : {}),
      token_endpoint: p.meta.token_endpoint,
      resource: this.mcpUrl,
    });
  }
}
