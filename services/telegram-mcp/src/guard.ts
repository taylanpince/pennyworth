// The one place Telegram access is limited (D-37). The session can do anything the user's account
// can, so every request any part of GramJS sends through `invoke` is checked against a fixed list
// of reads. Connection setup (InvokeWithLayer/InitConnection, pings) goes through the sender
// directly and carries no account action.

/** Requests the reading client may send. Nothing else reaches Telegram. */
export const READ_REQUESTS = new Set([
  "users.GetUsers", // getMe, senders
  "messages.GetDialogs",
  "messages.GetPeerDialogs",
  "messages.GetHistory",
  "messages.GetMessages",
  "channels.GetMessages",
  "messages.Search",
  "messages.SearchGlobal",
  "messages.GetChats",
  "channels.GetChannels",
  "channels.GetForumTopicsByID",
  "updates.GetState",
  "updates.GetDifference",
  "updates.GetChannelDifference",
  "help.GetConfig",
]);

/** Requests a sign-in from the board may send, on its own short-lived client (LogOut ends a sign-in as the wrong account). */
export const LOGIN_REQUESTS = new Set(["auth.SendCode", "auth.SignIn", "auth.LogOut", "account.GetPassword", "auth.CheckPassword", "users.GetUsers", "help.GetConfig", "updates.GetState"]);

// Defense in depth: never allowed on the reading client, even if someone adds it to READ_REQUESTS.
// Reads are Get*/Search* outside the account-level namespaces; anything else (sending, drafts,
// edits, reactions, joins, marking read, presence, contacts, sign-in, payments, downloads) and the
// few Gets with side effects (GetMessagesViews counts a view) never pass.
const NEVER_NAMESPACE = /^(auth|account|contacts|payments|upload|phone|stories|stickers|bots|langpack|photos|folders|chatlists|premium|smsjobs|fragment)\./;
const NEVER_METHOD = /Views|Read|Draft|Join|Import|Invite|Export|Check/;
const READ_SHAPE = /^[a-z]+\.(Get|Search)([A-Z]|$)/;

export function neverAllowed(className: string): boolean {
  return NEVER_NAMESPACE.test(className) || NEVER_METHOD.test(className) || !READ_SHAPE.test(className);
}

export class RefusedRequest extends Error {
  constructor(readonly request: string) {
    super(`Telegram request ${request} is not allowed (read-only access)`);
  }
}

type Invoker = { invoke: (request: any, ...rest: any[]) => Promise<any>; invokeWithSender?: (request: any, ...rest: any[]) => Promise<any> };

/** Whether the reading client may send this request. */
export function readAllowed(className: string): boolean {
  return READ_REQUESTS.has(className) && !neverAllowed(className);
}

/**
 * Replaces the client's `invoke` (and `invokeWithSender`) with a check against `allowed`. GramJS's
 * own helpers call `client.invoke`, so this sits below all of them. Refusals call `onRefused` with
 * the request's class name only.
 */
export function guard<T extends Invoker>(client: T, allowed: (className: string) => boolean, onRefused?: (className: string) => void): T {
  const check = (request: { className?: string }) => {
    const name = String(request?.className ?? "unknown");
    if (!allowed(name)) {
      onRefused?.(name);
      throw new RefusedRequest(name);
    }
  };
  const invoke = client.invoke.bind(client);
  client.invoke = (request, ...rest) => {
    try {
      check(request);
    } catch (err) {
      return Promise.reject(err);
    }
    return invoke(request, ...rest);
  };
  client.invokeWithSender = (request) => Promise.reject(new RefusedRequest(String(request?.className ?? "unknown")));
  return client;
}
