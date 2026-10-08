import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callLocalTool, LOCAL_TOOLS } from "../src/local-tools.js";
import { allowedTools, DEFAULT_ALLOWLIST, isAllowed } from "../src/policy.js";
import { isMine, type Me, type Message, mentionsMe, Scout } from "../src/scout.js";
import { parseTokenResponse, TokenStore } from "../src/tokens.js";

const tool = (name: string) => ({ name, inputSchema: { type: "object" as const }, annotations: { readOnlyHint: false } });
const tmp = () => mkdtempSync(join(tmpdir(), "telegram-mcp-"));

describe("telegram-mcp policy", () => {
  const upstreamNames = ["list_allowed_chats", "read_chat_history", "search_chat_history", "get_new_messages", "create_reply_draft", "request_allowed_chats_change", "get_pending_drafts"];

  it("exposes only allowlisted read tools, annotated read-only", () => {
    const out = allowedTools(upstreamNames.map(tool), new Set(DEFAULT_ALLOWLIST));
    expect(out.map((t) => t.name)).toEqual(DEFAULT_ALLOWLIST);
    expect(out.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.openWorldHint === false)).toBe(true);
  });

  it("never allows drafting, sending or changing the chat allowlist, even if allowlisted", () => {
    const allow = new Set(upstreamNames.concat(["send_message", "forward_message", "edit_message"]));
    for (const n of ["create_reply_draft", "request_allowed_chats_change", "get_pending_drafts", "send_message", "forward_message", "edit_message"]) expect(isAllowed(n, allow)).toBe(false);
    for (const n of DEFAULT_ALLOWLIST) expect(isAllowed(n, allow)).toBe(true);
  });

  it("local tools never touch Telegram itself", () => {
    expect(LOCAL_TOOLS.map((t) => t.name)).toEqual(["telegram_mentions", "telegram_mentions_ack", "telegram_followups"]);
    expect(LOCAL_TOOLS.every((t) => t.annotations?.openWorldHint === false)).toBe(true);
  });
});

describe("token handling", () => {
  it("parses token responses and errors", () => {
    expect(parseTokenResponse({ access_token: "a", refresh_token: "r", expires_in: 3600 }, 1000)).toMatchObject({ access_token: "a", refresh_token: "r", expires_at: 1000 + 3_600_000 });
    expect(() => parseTokenResponse({ error: "invalid_grant" })).toThrow(/invalid_grant/);
  });

  it("refreshes with the registered client and persists the new pair (0600)", async () => {
    const file = join(tmp(), "token.json");
    writeFileSync(file, JSON.stringify({ access_token: "old", refresh_token: "r-old", expires_at: Date.now() + 1000, client_id: "client_x", token_endpoint: "https://tg.example/token", resource: "https://tg.example/mcp" }));
    const seen: URLSearchParams[] = [];
    const fakeFetch = (async (url: string, init: { body: URLSearchParams }) => {
      expect(url).toBe("https://tg.example/token");
      seen.push(init.body);
      return new Response(JSON.stringify({ access_token: "new", refresh_token: "r-new", expires_in: 3600 }));
    }) as unknown as typeof fetch;
    const store = new TokenStore(file, fakeFetch);
    expect(await Promise.all([store.accessToken(), store.accessToken()])).toEqual(["new", "new"]);
    expect(seen).toHaveLength(1);
    expect(Object.fromEntries(seen[0]!)).toMatchObject({ grant_type: "refresh_token", refresh_token: "r-old", client_id: "client_x", resource: "https://tg.example/mcp" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ access_token: "new", refresh_token: "r-new", client_id: "client_x" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

const me: Me = { names: ["Dana Whitfield"], handles: ["danaw"], aliases: ["dana"] };

describe("who is the user", () => {
  it("recognises the user's display name, with or without a suffix", () => {
    expect(isMine({ display_name: "Dana Whitfield | Globex" }, me)).toBe(true);
    expect(isMine({ display_name: "dana whitfield" }, me)).toBe(true);
    expect(isMine({ display_name: "Dana Whitfieldson" }, me)).toBe(false);
    expect(isMine({ display_name: null }, me)).toBe(false);
  });

  it("finds mentions by handle or name as whole words", () => {
    expect(mentionsMe("@danaw can you check?", me)).toBe(true);
    expect(mentionsMe("cc @DanaW.", me)).toBe(true);
    expect(mentionsMe("dana or heena will get you access", me)).toBe(true);
    expect(mentionsMe("Thanks Dana!", me)).toBe(true);
    expect(mentionsMe("@danawhite please", me)).toBe(false);
    expect(mentionsMe("@dana_ops please", me)).toBe(false);
    expect(mentionsMe("Danaher stock", me)).toBe(false);
    expect(mentionsMe("nothing here", { names: [], handles: [], aliases: [] })).toBe(false);
  });
});

/** A fake upstream Telegram MCP over in-memory chats. */
function fakeTelegram(chats: { chat_ref: string; title: string; type: string; messages: Message[] }[]) {
  const calls: string[] = [];
  const find = (ref: unknown) => {
    const c = chats.find((x) => x.chat_ref === ref);
    if (!c) throw new Error("access denied");
    return c;
  };
  const upstream = async (name: string, a: Record<string, any>) => {
    calls.push(name);
    if (name === "list_allowed_chats") return chats.map(({ chat_ref, title, type }) => ({ chat_ref, title, type }));
    const c = find(a.chat_ref);
    const sorted = [...c.messages].sort((x, y) => x.message_id - y.message_id);
    if (name === "read_chat_history") {
      const before = a.before_message_id ?? Infinity;
      return sorted.filter((m) => m.message_id < before).reverse().slice(0, Math.min(a.limit ?? 20, 50));
    }
    if (name === "get_new_messages") return sorted.filter((m) => m.message_id > (a.after_message_id ?? 0)).slice(0, Math.min(a.limit ?? 100, 100));
    throw new Error(`unexpected tool ${name}`);
  };
  return { chats, calls, upstream };
}

const NOW = Date.parse("2026-10-08T12:00:00Z");
const msg = (chat_ref: string, message_id: number, display_name: string, text: string, opts: { hoursAgo?: number; reply?: number } = {}): Message => ({
  chat_ref,
  message_id,
  display_name,
  text: `<untrusted-telegram-content>\n${text}\n</untrusted-telegram-content>`,
  reply_to_message_id: opts.reply ?? null,
  timestamp: new Date(NOW - (opts.hoursAgo ?? 1) * 3_600_000).toISOString(),
});

describe("scout", () => {
  const setup = () => {
    const tg = fakeTelegram([
      {
        chat_ref: "chat_a",
        title: "Globex <> Us",
        type: "chat",
        messages: [
          msg("chat_a", 1, "Dana Whitfield | Us", "I'll send the deck tomorrow", { hoursAgo: 48 }),
          msg("chat_a", 5, "Sam Client", "old question for dana", { hoursAgo: 30 }),
          msg("chat_a", 10, "Sam Client", "dana or heena will get you access", { hoursAgo: 3 }),
          msg("chat_a", 11, "Lee Client", "unrelated chatter", { hoursAgo: 2 }),
          msg("chat_a", 12, "Dana Whitfield | Us", "I'll look into it today", { hoursAgo: 2 }),
          msg("chat_a", 13, "Sam Client", "great, thanks", { hoursAgo: 1, reply: 12 }),
        ],
      },
      { chat_ref: "chat_d", title: "Sam Client", type: "user", messages: [msg("chat_d", 3, "Sam Client", "got a minute?", { hoursAgo: 1 })] },
    ]);
    const statePath = join(tmp(), "scout.json");
    const make = () => new Scout(tg.upstream, me, statePath, 24, () => NOW);
    return { tg, statePath, make, scout: make() };
  };
  const ids = (out: { candidates: { message_id: number }[] }) => out.candidates.map((c) => c.message_id);
  const ackAll = (scout: Scout, out: { candidates: { chat_ref: string; message_id: number }[] }) => scout.ack(out.candidates.map(({ chat_ref, message_id }) => ({ chat_ref, message_id })));

  it("first scan looks back lookback hours and classifies candidates with context", async () => {
    const { scout } = setup();
    await scout.refresh();
    const out = await scout.candidates({ max: 30 });
    expect(out.errors).toEqual([]);
    expect(out.candidates.map((c) => [c.chat_ref, c.message_id, c.kinds])).toEqual([
      ["chat_a", 10, ["mention"]],
      ["chat_a", 12, ["own"]],
      ["chat_a", 13, ["reply"]],
      ["chat_d", 3, ["dm"]],
    ]);
    const c10 = out.candidates[0]!;
    expect(c10.chat_title).toBe("Globex <> Us");
    expect(c10.user_posted_after).toBe(true);
    expect(c10.user_replied_directly).toBe(false);
    expect(c10.context_before.map((m) => m.message_id)).toEqual([1, 5]); // IDs have gaps in small groups and DMs
    expect(out.candidates[2]!.reply_to?.message_id).toBe(12);
    expect(out.candidates[2]!.reply_to?.from_user).toBe(true);
  });

  it("waits for the first scan after a start, then answers from prepared results", async () => {
    const { tg, scout } = setup();
    expect(ids(await scout.candidates({ max: 30 }))).toEqual([10, 12, 13, 3]);
    const calls = tg.calls.length;
    await scout.candidates({ max: 30 });
    expect(tg.calls.length).toBe(calls); // no upstream calls on the agent's path
  });

  it("only reads chats with new messages, and keeps unacknowledged candidates", async () => {
    const { tg, scout } = setup();
    await scout.refresh();
    const first = await scout.candidates({ max: 30 });
    expect(scout.ack(first.candidates.filter((c) => c.message_id !== 10).map(({ chat_ref, message_id }) => ({ chat_ref, message_id })))).toEqual({ acknowledged: 3, still_pending: 1 });

    tg.calls.length = 0;
    await scout.refresh(); // nothing new: one list and one cursor read per chat
    expect(tg.calls).toEqual(["list_allowed_chats", "get_new_messages", "get_new_messages"]);

    tg.chats[0]!.messages.push(msg("chat_a", 14, "Lee Client", "@danaw can you approve?", { hoursAgo: 0.5 }));
    await scout.refresh();
    const second = await scout.candidates({ max: 30 });
    expect(ids(second)).toEqual([10, 14]);
    expect(second.candidates[0]!.after.map((m) => m.message_id)).toContain(14); // context refreshed
    // Unacknowledged: handed out at most 3 times, then dropped.
    await scout.candidates({ max: 30 });
    expect(ids(await scout.candidates({ max: 30 }))).toEqual([14]);
  });

  it("re-prepares context after a restart without rescanning old messages", async () => {
    const { make, scout } = setup();
    await scout.refresh();
    const again = make();
    expect(ids(await again.candidates({ max: 30 }))).toEqual([10, 12, 13, 3]);
  });

  it("recognises replies to the user's messages outside the scanned window", async () => {
    const { tg, scout } = setup();
    await scout.refresh();
    ackAll(scout, await scout.candidates({ max: 30 }));
    tg.chats[0]!.messages.push(msg("chat_a", 60, "Sam Client", "any update on the deck?", { hoursAgo: 0.2, reply: 1 }));
    await scout.refresh();
    const c = (await scout.candidates({ max: 30 })).candidates.find((x) => x.message_id === 60);
    expect(c?.kinds).toEqual(["reply"]);
    expect(c?.reply_to?.message_id).toBe(1);
  });

  it("pages through busy chats and caps each call", async () => {
    const { tg, scout } = setup();
    await scout.refresh();
    ackAll(scout, await scout.candidates({ max: 30 }));
    for (let i = 100; i < 750; i++) tg.chats[0]!.messages.push(msg("chat_a", i, "Lee Client", i % 50 === 0 ? "ping dana" : "noise", { hoursAgo: 0.1 }));
    await scout.refresh();
    const out = await scout.candidates({ max: 2 });
    expect(ids(out)).toEqual([100, 150]);
    expect(out.more_ready + out.waiting_for_context).toBe(11);
    expect(out.waiting_for_context).toBe(0); // candidates far apart still get context
  });

  it("drops candidates whose message was deleted", async () => {
    const { tg, scout } = setup();
    await scout.refresh();
    tg.chats[0]!.messages = tg.chats[0]!.messages.filter((m) => m.message_id !== 10);
    tg.chats[0]!.messages.push(msg("chat_a", 20, "Lee Client", "hi", { hoursAgo: 0.1 }));
    await scout.refresh();
    expect(ids(await scout.candidates({ max: 30 }))).toEqual([12, 13, 3]);
    // Also when it was the chat's newest candidate.
    tg.chats[1]!.messages = [msg("chat_d", 9, "Dana Whitfield", "sure", { hoursAgo: 0.1 })];
    await scout.refresh();
    expect(ids(await scout.candidates({ max: 30 }))).toEqual([12, 13, 9]);
  });

  it("drops state for chats whose ref changed, keeps no message text on disk, and follows up by title", async () => {
    const { tg, statePath, scout } = setup();
    await scout.refresh();
    tg.chats[0]!.chat_ref = "chat_a2";
    for (const m of tg.chats[0]!.messages) m.chat_ref = "chat_a2";
    await scout.refresh();
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(Object.keys(state.chats).sort()).toEqual(["chat_a2", "chat_d"]);
    expect(state.pending.some((p: { chat_ref: string }) => p.chat_ref === "chat_a")).toBe(false);
    expect(JSON.stringify(state)).not.toMatch(/access|deck|minute/);

    const { results } = await scout.followups([{ chat_ref: "chat_a", chat_title: "Globex <> Us", message_id: 10 }, { chat_ref: "chat_gone", chat_title: "Nope", message_id: 1 }]);
    expect(results[0]).toMatchObject({ found: true, chat_ref: "chat_a2", user_replied_directly: false });
    expect((results[0] as { user_messages_after: unknown[] }).user_messages_after).toHaveLength(1);
    expect(results[1]).toMatchObject({ found: false });
  });

  it("validates local tool input", async () => {
    const { scout } = setup();
    await expect(callLocalTool(scout, "telegram_mentions_ack", { items: [] })).rejects.toThrow();
    await expect(callLocalTool(scout, "telegram_mentions", { max: 1000 })).rejects.toThrow();
  });
});
