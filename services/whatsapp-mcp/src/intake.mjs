const normalize = (jid) =>
  typeof jid === "string"
    ? jid.replace(/:\d+@/, "@").replace(/@c\.us$/, "@s.whatsapp.net")
    : "";
export function identities(...users) {
  return new Set(
    users
      .flatMap((u) => [u?.id, u?.lid, u?.phoneNumber])
      .map(normalize)
      .filter(Boolean),
  );
}
export function ingest(
  store,
  message,
  self,
  { candidate = true, aliases = [] } = {},
) {
  const key = message.key || {},
    chat = key.remoteJid;
  if (!chat || !key.id || chat === "status@broadcast") return;
  let body = message.message;
  for (let n = 0; n < 5; n++) {
    const wrapped =
      body?.ephemeralMessage?.message ||
      body?.viewOnceMessage?.message ||
      body?.viewOnceMessageV2?.message ||
      body?.documentWithCaptionMessage?.message;
    if (!wrapped) break;
    body = wrapped;
  }
  if (!body || body.reactionMessage || body.protocolMessage) return;
  const content =
    body.extendedTextMessage ||
    body.imageMessage ||
    body.videoMessage ||
    body.documentMessage ||
    body.audioMessage ||
    body.stickerMessage ||
    {};
  const context = content.contextInfo || {};
  const text =
    body.conversation ||
    content.text ||
    content.caption ||
    (body.audioMessage
      ? "[Voice message]"
      : body.imageMessage
        ? "[Image]"
        : body.videoMessage
          ? "[Video]"
          : body.documentMessage
            ? "[Document]"
            : body.stickerMessage
              ? "[Sticker]"
              : "");
  if (!text) return;
  const own = !!key.fromMe;
  const mention =
    !own &&
    ((context.mentionedJid || []).some((j) => self.has(normalize(j))) ||
      aliases.some((a) =>
        new RegExp(
          `\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "iu",
        ).test(text),
      ));
  const reply =
    !own &&
    !!context.stanzaId &&
    (self.has(normalize(context.participant)) ||
      store.own(chat, context.stanzaId));
  store.chat(chat, chat);
  store.add({
    chat,
    id: key.id,
    text,
    sender: message.pushName || key.participant || chat,
    own,
    at: Number(message.messageTimestamp) * 1000 || Date.now(),
    mention: candidate && mention,
    reply: candidate && reply,
  });
  if (candidate && own && context.stanzaId)
    store.answer(chat, context.stanzaId);
}
export function react(store, event, self, emoji = "📌") {
  const actor = event.reaction?.key;
  if (
    !actor ||
    !(
      actor.fromMe ||
      self.has(normalize(actor.participant)) ||
      self.has(normalize(actor.participantAlt))
    )
  )
    return;
  if (
    !event.key?.remoteJid ||
    !event.key.id ||
    event.key.remoteJid === "status@broadcast"
  )
    return;
  store.reaction(
    event.key.remoteJid,
    event.key.id,
    event.reaction.text === emoji,
    Number(event.reaction.senderTimestampMs) || Date.now(),
  );
}
