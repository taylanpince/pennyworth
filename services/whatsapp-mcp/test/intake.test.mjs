import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { identities, ingest, react } from "../src/intake.mjs";
const me = identities({ id: "123:7@s.whatsapp.net", lid: "999@lid" });
const msg = (id, content, own = false) => ({
  key: { remoteJid: "group@g.us", id, fromMe: own },
  messageTimestamp: Math.floor(Date.now() / 1000),
  message: content,
});
test("all chats: ordinary messages are context; phone/LID mentions and quoted replies trigger", () => {
  const s = new Store(":memory:", { allChats: true });
  ingest(s, msg("normal", { conversation: "hello" }), me);
  assert.equal(s.pending().length, 0);
  assert.equal(s.history("group@g.us").length, 1);
  ingest(s, msg("own", { conversation: "my message" }, true), me);
  ingest(
    s,
    msg("reply", {
      extendedTextMessage: { text: "reply", contextInfo: { stanzaId: "own" } },
    }),
    me,
  );
  ingest(
    s,
    msg("mention", {
      extendedTextMessage: {
        text: "ping",
        contextInfo: { mentionedJid: ["999@lid"] },
      },
    }),
    me,
  );
  assert.deepEqual(
    s.pending().map((x) => x.id),
    ["reply", "mention"],
  );
  const old = s.pending()[0];
  s.ack([{ chat: old.chat, id: old.id, revision: old.revision }]);
  ingest(
    s,
    msg(
      "response",
      {
        extendedTextMessage: {
          text: "done",
          contextInfo: { stanzaId: "reply" },
        },
      },
      true,
    ),
    me,
  );
  assert.equal(s.pending().find((x) => x.id === "reply").answered, 1);
  s.ack([{ chat: old.chat, id: old.id, revision: old.revision }]);
  assert.ok(s.pending().find((x) => x.id === "reply"));
});
test("only own task reactions trigger; replay does not reopen, unpin is queued, unknown targets are retained", () => {
  const s = new Store(":memory:", { allChats: true });
  const reaction = (text, fromMe = true) => ({
    key: { remoteJid: "chat@s.whatsapp.net", id: "old" },
    reaction: { key: { fromMe }, text },
  });
  react(s, reaction("📌", false), me);
  assert.equal(s.pending().length, 0);
  react(s, reaction("📌"), me);
  const p = s.pending()[0];
  assert.equal(p.pinned, 1);
  s.ack([{ chat: p.chat, id: p.id, revision: p.revision }]);
  react(s, reaction("📌"), me);
  assert.equal(s.pending().length, 0);
  react(s, reaction(""), me);
  assert.equal(s.pending()[0].pinned, 0);
  assert.equal(s.pending()[0].pin_seen, 1);
});
test("history is context only; later live delivery triggers; aliases and nested content supported", () => {
  const s = new Store(":memory:", { allChats: true });
  const m = msg("historic", {
    extendedTextMessage: {
      text: "@you",
      contextInfo: { mentionedJid: ["123@s.whatsapp.net"] },
    },
  });
  ingest(s, m, me, { candidate: false });
  assert.equal(s.pending().length, 0);
  ingest(s, m, me);
  assert.equal(s.pending().length, 1);
  ingest(
    s,
    msg("alias", {
      ephemeralMessage: { message: { conversation: "Taylan, please check" } },
    }),
    me,
    { aliases: ["Taylan"] },
  );
  assert.equal(s.pending().length, 2);
});

test("older reaction replay cannot restore an unpinned task", () => {
  const s = new Store(":memory:", { allChats: true });
  s.reaction("c", "m", true, 1000);
  s.reaction("c", "m", false, 2000);
  const item = s.pending()[0];
  s.ack([{ chat: "c", id: "m", revision: item.revision }]);
  s.reaction("c", "m", true, 1000);
  assert.equal(s.pending().length, 0);
  assert.equal(s.history("c")[0].pinned, 0);
});
