import { z } from "zod";
import type { GoogleAccountStatus } from "./google.js";
import type { McpAuthStatus } from "./mcpauth.js";
import type { SignInProvider } from "./signins.js";
import type { TelegramStatus } from "./telegram.js";

/**
 * Every connection Pennyworth has, for the Settings page: who it's for, whether it works, as whom,
 * and how to (re)connect it. Board sign-ins report through their proxies' auth endpoints; sign-ins
 * made on the laptop (GitHub, Google Cloud, AWS, Primer, the engines) are checked by the runner,
 * which lives there, and reported to the internal API. Nothing here holds or shows a credential.
 */

export type ConnectionState = "ok" | "attention" | "off" | "unset" | "unknown";

export interface ConnectionAccount {
  /** The proxy's id for the sign-in, where accounts are added and removed one by one (Jira, D-69). */
  id?: string;
  label: string;
  state: ConnectionState;
  detail?: string;
  primary?: boolean;
}

export type ConnectionAction =
  /**
   * A sign-in on the board's own page (/<service>/connect), on the laptop's loopback address only. With `multiple`,
   * each sign-in adds an account (or reconnects that account), and an account can be removed (Jira, D-69).
   */
  | { kind: "connect"; href: string; multiple?: true }
  /** A sign-in form on the Settings page itself. */
  | { kind: "panel"; panel: "google" | "slack" | "telegram" | "whatsapp" }
  /** A sign-in the runner makes on the laptop, driven from Settings (D-66), with the terminal command as a fallback. */
  | { kind: "signin"; provider: SignInProvider; command: string; note?: string }
  /** A sign-in made in a terminal on the laptop. */
  | { kind: "command"; command: string; note?: string }
  /** Nothing to do from here (set up in .env or a config file first). */
  | { kind: "setup"; note: string };

export interface Connection {
  id: string;
  name: string;
  group: "board" | "laptop";
  purpose: string;
  usedBy: string;
  state: ConnectionState;
  detail?: string;
  since?: string;
  checkedAt?: string;
  accounts: ConnectionAccount[];
  action: ConnectionAction;
}

/** One check the runner made on the laptop (POST /internal/runner/connections). */
const HostCheck = z
  .object({
    id: z.enum(["github", "gh", "primer", "slack", "gcloud", "aws", "claude", "codex", "openrouter", "paperclip-codex"]),
    state: z.enum(["ok", "expired", "missing", "error", "unset"]),
    detail: z.string().max(300).optional(),
    accounts: z
      .array(z.object({ label: z.string().min(1).max(200), state: z.enum(["ok", "expired", "missing", "error"]), detail: z.string().max(300).optional() }).strict())
      .max(50)
      .optional(),
  })
  .strict();
export const HostReportSchema = z.object({ checks: z.array(HostCheck).max(20) }).strict();
export type HostCheck = z.infer<typeof HostCheck>;
export type HostReport = { checks: HostCheck[]; at: string };

export interface ConnectionInputs {
  google?: { accounts: GoogleAccountStatus[]; configured?: boolean; error?: string } | null;
  /** Whether the board can drive Google's sign-in (google_auth_token). */
  googleEnabled: boolean;
  telegram?: (TelegramStatus & { configured?: boolean }) | null;
  telegramEnabled: boolean;
  slack?: { configured?: boolean; connected?: boolean } | null;
  slackEnabled: boolean;
  whatsapp?: { state?: string } | null;
  whatsappEnabled: boolean;
  /** The OAuth proxies the board can sign in (D-38, D-48, D-57, D-64): null when set up but not answering. */
  proxies: Partial<Record<"glean" | "grafana" | "clickhouse" | "cloudflare" | "jira" | "primer", McpAuthStatus | null>>;
  host?: HostReport;
}

const hostState = (s: HostCheck["state"] | ConnectionAccount["state"] | undefined): ConnectionState =>
  s === "ok" ? "ok" : s === "missing" ? "off" : s === "unset" ? "unset" : s === "expired" || s === "error" ? "attention" : "unknown";

/** The worst state among accounts: one expired account needs attention even if the rest work. */
const worst = (states: ConnectionState[], empty: ConnectionState): ConnectionState => {
  for (const s of ["attention", "unknown", "off", "ok", "unset"] as const) if (states.includes(s)) return s;
  return empty;
};

function mcpProxy(id: string, s: McpAuthStatus | null | undefined, env: string): Pick<Connection, "state" | "detail" | "since" | "accounts" | "action"> {
  if (s === undefined) return { state: "unset", accounts: [], action: { kind: "setup", note: `Set ${env} in .env and recreate ${id}-mcp and the board.` } };
  const action: ConnectionAction = { kind: "connect", href: `/${id}/connect`, ...(id === "jira" ? { multiple: true as const } : {}) };
  if (!s) return { state: "unknown", detail: `${id}-mcp didn't answer`, accounts: [], action };
  if (!s.configured) return { state: "unset", accounts: [], action: { kind: "setup", note: `Set ${env} in .env and recreate ${id}-mcp.` } };
  const toState = (x: McpAuthStatus["state"]): ConnectionState => (x === "ok" ? "ok" : x === "expired" ? "attention" : x === "missing" ? "off" : "unknown");
  const state = toState(s.state);
  const accounts: ConnectionAccount[] = s.accounts
    ? s.accounts.map((a) => ({ id: a.id, label: a.label, state: toState(a.state), ...(a.detail ? { detail: a.detail } : {}) }))
    : s.account
      ? [{ label: s.account, state }]
      : [];
  return { state, ...(s.detail ? { detail: s.detail } : {}), since: s.since, accounts, action };
}

function fromHost(host: HostReport | undefined, id: HostCheck["id"]): Pick<Connection, "state" | "detail" | "accounts" | "checkedAt"> {
  const c = host?.checks.find((x) => x.id === id);
  if (!c) return { state: "unknown", detail: host ? "the runner didn't report it" : "waiting for the runner's first check", accounts: [] };
  const accounts = (c.accounts ?? []).map((a) => ({ label: a.label, state: hostState(a.state), ...(a.detail ? { detail: a.detail } : {}) }));
  const state = accounts.length && c.state === "ok" ? worst(accounts.map((a) => a.state), "ok") : hostState(c.state);
  return { state, ...(c.detail ? { detail: c.detail } : {}), accounts, checkedAt: host!.at };
}

export function connectionsView(i: ConnectionInputs): Connection[] {
  const out: Connection[] = [];

  // Signed in on the board.
  const g = i.google;
  const googleAccounts: ConnectionAccount[] = (g?.accounts ?? []).map((a) => ({
    label: a.email,
    state: a.state === "ok" ? "ok" : a.state === "unknown" ? "unknown" : "attention",
    ...(a.detail ? { detail: a.detail } : {}),
    ...(a.primary ? { primary: true } : {}),
  }));
  out.push({
    id: "google",
    name: "Google",
    group: "board",
    purpose: "Gmail, Calendar, Drive and Docs, read-only. The primary account's calendar is the one meetings come from.",
    usedBy: "Alfred, Ursula, the Inbox Agent, the Chief of Staff and the Meeting Librarian",
    state: !i.googleEnabled ? "unset" : g === null || g === undefined ? "unknown" : worst(googleAccounts.map((a) => a.state), "off"),
    ...(g?.error ? { detail: g.error } : {}),
    accounts: googleAccounts,
    action: i.googleEnabled ? { kind: "panel", panel: "google" } : { kind: "command", command: "scripts/google-auth.sh --email you@example.com --primary" },
  });

  // Slack: the board's sign-in when it's on (compose.connections.yaml), and the runner's read of the profile either way.
  const slackHost = fromHost(i.host, "slack");
  const slackBoard = i.slack;
  out.push({
    id: "slack",
    name: "Slack",
    group: "board",
    purpose: "Your Slack, read-only (DMs included), and drafts you send yourself. Messages you pin with :pushpin: become tasks.",
    usedBy: "the Slack Scout, Alfred, Ursula and the Engineers",
    ...slackHost,
    // Until the runner has checked, the board's own sign-in says whether Slack is connected.
    ...(slackBoard && slackHost.state !== "ok" && slackHost.state !== "attention" ? (slackBoard.connected ? { state: "ok" as const, detail: undefined } : { state: "off" as const }) : {}),
    action: i.slackEnabled ? { kind: "panel", panel: "slack" } : { kind: "command", command: "scripts/slack-auth.sh", note: "Add compose.connections.yaml to COMPOSE_FILE to connect Slack from here instead." },
  });

  const t = i.telegram;
  const tState: ConnectionState = !i.telegramEnabled || t?.configured === false ? "unset" : !t ? "unknown" : t.state === "ok" ? "ok" : t.state === "missing" ? "off" : "attention";
  out.push({
    id: "telegram",
    name: "Telegram",
    group: "board",
    purpose: "Your own Telegram session, reads only: mentions, replies and DMs become tasks. Nothing is ever marked read.",
    usedBy: "the Telegram Scout and Alfred",
    state: tState,
    ...(t?.since ? { since: t.since } : {}),
    ...(t?.detail ? { detail: t.detail } : {}),
    accounts: t?.account ? [{ label: t.account.username ? `${t.account.name} (@${t.account.username})` : t.account.name, state: tState }] : [],
    action: i.telegramEnabled ? { kind: "panel", panel: "telegram" } : { kind: "setup", note: "Set up telegram-mcp (TELEGRAM_API_ID and the telegram_auth_token secret)." },
  });

  if (i.whatsappEnabled) {
    const w = i.whatsapp;
    out.push({
      id: "whatsapp",
      name: "WhatsApp",
      group: "board",
      purpose: "Mentions, replies and reactions in the chats you pick become tasks.",
      usedBy: "the WhatsApp Scout",
      state: !w ? "unknown" : w.state === "connected" ? "ok" : w.state === "disconnected" || w.state === "unpaired" ? "off" : "attention",
      accounts: [],
      action: { kind: "panel", panel: "whatsapp" },
    });
  }

  const proxies: ["glean" | "grafana" | "clickhouse" | "cloudflare" | "jira" | "primer", string, string, string, string][] = [
    ["primer", "Primer", "PRIMER_MCP_URL", "The org's documents: reading, and publishing when you ask.", "Alfred, Ursula and the Engineers"],
    ["glean", "Glean", "GLEAN_MCP_URL", "The company's search across Slack, Drive, Confluence, Jira, GitHub and people.", "Alfred, Ursula and the Engineers"],
    ["grafana", "Grafana", "GRAFANA_URL", "Logs, metrics, traces, dashboards and alerts, with read and query scopes only.", "the Engineers"],
    ["clickhouse", "ClickHouse", "CLICKHOUSE_MCP_URL", "ClickHouse Cloud: services, schemas and checked SELECT queries.", "Alfred and the Engineers"],
    ["cloudflare", "Cloudflare", "CLOUDFLARE_MCP_URL", "Every Cloudflare account and zone you can see, with read scopes only.", "Alfred and the Engineers"],
    ["jira", "Jira and Confluence", "JIRA_MCP_URL", "Every Atlassian account you add, a client's own Jira too: reads, and Jira issues opened, edited, commented on or moved when you ask Alfred. Never deletes.", "Alfred, Ursula and the Engineers"],
  ];
  for (const [id, name, env, purpose, usedBy] of proxies) out.push({ id, name, group: "board", purpose, usedBy, ...mcpProxy(id, id in i.proxies ? i.proxies[id] : undefined, env) });

  // Signed in on the laptop, checked by the runner.
  const laptop: [HostCheck["id"], string, string, string, ConnectionAction][] = [
    ["github", "GitHub (Alfred)", "Issues and pull requests as you: reads, and comments, issues, reviews and CI re-runs when you ask. It's gh's token, copied for github-mcp.", "Alfred", { kind: "signin", provider: "github", command: "scripts/github-auth.sh" }],
    ["gh", "GitHub (Engineers)", "Cloning, pushing and pull requests from the Engineers' workspaces, on your word. Signing in again keeps the token's scopes.", "the Engineers", { kind: "signin", provider: "gh", command: "gh auth login" }],
    ["gcloud", "Google Cloud", "Logs, Monitoring, GKE, Cloud Run and the rest, read-only by the prompt's rule. Google ends the session after 16 hours.", "the Engineers", { kind: "signin", provider: "gcloud", command: "scripts/gcloud-auth.sh" }],
    ["aws", "AWS", "Read roles for every account in config/runner.yaml; changes run with the write role, on your word.", "the Engineers", { kind: "signin", provider: "aws", command: "scripts/aws-auth.sh" }],
    ["claude", "Claude Code", "The engine for Claude jobs, in its own home with no plugins or connectors.", "the Engineers on Claude", { kind: "signin", provider: "claude", command: "claude setup-token", note: "Save the token it prints to ~/.config/pennyworth/claude_oauth_token (0600)." }],
    ["codex", "Codex (Engineers)", "Your ChatGPT sign-in for Codex jobs on the laptop.", "the Engineers on Codex", { kind: "signin", provider: "codex", command: "codex login" }],
    ["paperclip-codex", "Codex (Paperclip agents)", "The ChatGPT sign-in every Paperclip agent runs on.", "Alfred, Ursula and the scouts", { kind: "signin", provider: "paperclip-codex", command: `docker compose exec -it -u node paperclip codex -c 'cli_auth_credentials_store="file"' login --device-auth` }],
    ["openrouter", "OpenRouter", "Other models (DeepSeek, GLM…) for Engineer jobs, without private data.", "the Engineers on OpenRouter", { kind: "signin", provider: "openrouter", command: "~/.config/pennyworth/openrouter_key", note: "Or save an OpenRouter API key to this file (0600)." }],
  ];
  for (const [id, name, purpose, usedBy, action] of laptop) {
    const h = fromHost(i.host, id);
    out.push({ id, name, group: "laptop", purpose, usedBy, ...h, action });
  }
  return out;
}
