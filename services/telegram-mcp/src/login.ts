// Signing in from the board (D-37): phone number, then the code Telegram sends to the user's app,
// then the 2FA password if the account has one. A separate, short-lived client with its own request
// list; the reading client never gets auth.*. Nothing entered here is logged or stored, except the
// resulting session.
import { randomBytes } from "node:crypto";
import { Api, type TelegramClient } from "telegram";
import { computeCheck } from "telegram/Password.js";
import { LOGIN_REQUESTS } from "./guard.js";
import { type ApiCredentials, newClient } from "./reader.js";

export class LoginError extends Error {}

const PENDING_MS = 10 * 60_000;

interface Pending {
  id: string;
  client: TelegramClient;
  phone: string;
  phoneCodeHash?: string;
  step: "code" | "password";
  expires: number;
}

export type LoginResult = { step: "code" | "password"; login_id: string; via_app?: boolean } | { step: "done"; account: { id: string; name: string; username: string | null } };

/** Telegram's answers a person can act on, in plain words; anything else is a generic failure. */
const FRIENDLY: Record<string, string> = {
  PHONE_NUMBER_INVALID: "that phone number isn't valid (use the international format, +34…)",
  PHONE_NUMBER_BANNED: "Telegram has banned this phone number",
  PHONE_CODE_INVALID: "that code isn't right",
  PHONE_CODE_EXPIRED: "the code expired; start again",
  PASSWORD_HASH_INVALID: "that password isn't right",
  PHONE_NUMBER_UNOCCUPIED: "there is no Telegram account for this number",
  API_ID_INVALID: "telegram/api.json has an invalid api_id/api_hash",
};

function explain(err: unknown): LoginError {
  const code = (err as { errorMessage?: string }).errorMessage;
  if (code?.startsWith("FLOOD_WAIT")) return new LoginError(`Telegram asks to wait ${(err as { seconds?: number }).seconds ?? "a while"} seconds before trying again`);
  return new LoginError(code ? (FRIENDLY[code] ?? `Telegram refused the sign-in (${code})`) : "the sign-in failed; see the telegram-mcp log");
}

export class Login {
  private pending?: Pending;

  constructor(
    private readonly api: () => ApiCredentials,
    /** The account already on file: a sign-in as anyone else is refused. */
    private readonly expectedAccount: () => string | undefined,
    /** Stores the new session and restarts the reading client with it. */
    private readonly onSession: (session: string, account: { id: string; name: string; username: string | null }) => Promise<void>,
  ) {}

  private async drop() {
    const p = this.pending;
    this.pending = undefined;
    await p?.client.destroy().catch(() => undefined);
  }

  private current(id: string, step: Pending["step"]): Pending {
    const p = this.pending;
    if (!p || p.id !== id || p.expires < Date.now()) throw new LoginError("this sign-in expired; start again");
    if (p.step !== step) throw new LoginError(`this sign-in is waiting for the ${p.step}`);
    return p;
  }

  async start(phone: string): Promise<LoginResult> {
    await this.drop();
    const client = newClient("", this.api(), (c) => LOGIN_REQUESTS.has(c));
    const id = randomBytes(16).toString("hex");
    try {
      await client.connect();
      const sent = await client.sendCode({ apiId: this.api().api_id, apiHash: this.api().api_hash }, phone);
      this.pending = { id, client, phone, phoneCodeHash: sent.phoneCodeHash, step: "code", expires: Date.now() + PENDING_MS };
      setTimeout(() => this.pending?.id === id && void this.drop(), PENDING_MS).unref();
      return { step: "code", login_id: id, via_app: sent.isCodeViaApp };
    } catch (err) {
      await client.destroy().catch(() => undefined);
      throw explain(err);
    }
  }

  async code(id: string, code: string): Promise<LoginResult> {
    const p = this.current(id, "code");
    try {
      const r = await p.client.invoke(new Api.auth.SignIn({ phoneNumber: p.phone, phoneCodeHash: p.phoneCodeHash!, phoneCode: code }));
      if (r instanceof Api.auth.AuthorizationSignUpRequired) throw new LoginError("there is no Telegram account for this number");
      return await this.finish(p);
    } catch (err) {
      if ((err as { errorMessage?: string }).errorMessage === "SESSION_PASSWORD_NEEDED") {
        p.step = "password";
        return { step: "password", login_id: p.id };
      }
      if (err instanceof LoginError) {
        await this.drop();
        throw err;
      }
      throw explain(err);
    }
  }

  async password(id: string, password: string): Promise<LoginResult> {
    const p = this.current(id, "password");
    try {
      const srp = await p.client.invoke(new Api.account.GetPassword());
      await p.client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(srp, password) }));
      return await this.finish(p);
    } catch (err) {
      if (err instanceof LoginError) {
        await this.drop();
        throw err;
      }
      throw explain(err);
    }
  }

  private async finish(p: Pending): Promise<LoginResult> {
    const me = await p.client.getMe();
    const account = { id: me.id.toString(), name: [me.firstName, me.lastName].filter(Boolean).join(" "), username: me.username ?? null };
    const expected = this.expectedAccount();
    if (expected && expected !== account.id) {
      // Signed in, but as someone else: end that session again rather than keep it.
      await p.client.invoke(new Api.auth.LogOut()).catch(() => undefined);
      throw new LoginError("that is a different Telegram account than the one Pennyworth is set up with; delete the session file to switch accounts");
    }
    const session = String(p.client.session.save());
    this.pending = undefined;
    // destroy, not disconnect: a disconnected client keeps its update loop, which pings forever.
    await p.client.destroy().catch(() => undefined);
    await this.onSession(session, account);
    return { step: "done", account };
  }
}
