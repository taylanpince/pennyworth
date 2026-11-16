import { DatabaseSync } from "node:sqlite";
export class Store {
  constructor(path, { allChats = false } = {}) {
    this.allChats = allChats;
    this.db = new DatabaseSync(path);
    this.db.exec(
      `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,name TEXT NOT NULL,selected INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS messages(chat TEXT,id TEXT,text TEXT,sender TEXT,own INTEGER,at INTEGER,handled INTEGER DEFAULT 0,PRIMARY KEY(chat,id));`,
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value INTEGER NOT NULL)",
    );
    if (allChats)
      this.db
        .prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)")
        .run("attention_since", Date.now());
    this.attentionSince =
      this.db
        .prepare("SELECT value FROM settings WHERE key=?")
        .get("attention_since")?.value ?? Date.now();
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(messages)")
        .all()
        .map((c) => c.name),
    );
    for (const name of [
      "mention",
      "reply",
      "pinned",
      "pin_seen",
      "answered",
      "revision",
      "reaction_at",
    ]) {
      if (!columns.has(name))
        this.db.exec(
          `ALTER TABLE messages ADD COLUMN ${name} INTEGER NOT NULL DEFAULT ${name === "revision" ? 1 : 0}`,
        );
    }
  }
  allowed(chat) {
    return (
      this.allChats ||
      !!this.db
        .prepare("SELECT id FROM chats WHERE id=? AND selected=1")
        .get(chat)
    );
  }
  own(chat, id) {
    return !!this.db
      .prepare("SELECT id FROM messages WHERE chat=? AND id=? AND own=1")
      .get(chat, id);
  }
  chat(id, name) {
    if (!id || id === "status@broadcast") return;
    this.db
      .prepare(
        "INSERT INTO chats(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=CASE WHEN excluded.name=excluded.id THEN chats.name ELSE excluded.name END",
      )
      .run(id, name || id);
  }
  chats() {
    return this.db
      .prepare("SELECT id,name,selected FROM chats ORDER BY name")
      .all();
  }
  select(ids) {
    if (
      !Array.isArray(ids) ||
      ids.length > 1000 ||
      ids.some(
        (id) =>
          typeof id !== "string" ||
          !this.db.prepare("SELECT id FROM chats WHERE id=?").get(id),
      )
    )
      throw new Error("Choose existing chats");
    this.db.exec("BEGIN");
    try {
      this.db.exec("UPDATE chats SET selected=0");
      for (const id of ids)
        this.db.prepare("UPDATE chats SET selected=1 WHERE id=?").run(id);
      this.db.exec(
        "DELETE FROM messages WHERE chat NOT IN (SELECT id FROM chats WHERE selected=1); COMMIT",
      );
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  add(m) {
    if (!this.allowed(m.chat)) return;
    if (!m.id || !m.text || m.text.length > 20000) return;
    this.db
      .prepare(
        "INSERT INTO messages(chat,id,text,sender,own,at,mention,reply) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(chat,id) DO UPDATE SET text=excluded.text,sender=excluded.sender,own=excluded.own,at=excluded.at, handled=CASE WHEN excluded.mention>messages.mention OR excluded.reply>messages.reply THEN 0 ELSE messages.handled END, revision=revision+CASE WHEN excluded.mention>messages.mention OR excluded.reply>messages.reply THEN 1 ELSE 0 END, mention=MAX(messages.mention,excluded.mention),reply=MAX(messages.reply,excluded.reply)",
      )
      .run(
        m.chat,
        m.id,
        m.text,
        m.sender || "",
        m.own ? 1 : 0,
        m.at,
        m.mention ? 1 : 0,
        m.reply ? 1 : 0,
      );
    this.db
      .prepare("DELETE FROM messages WHERE at<?")
      .run(Date.now() - 30 * 86400000);
  }
  reaction(chat, id, pinned, at = Date.now()) {
    if (!this.allowed(chat) || !id) return;
    this.chat(chat, chat);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO messages(chat,id,text,sender,own,at) VALUES(?,?,?,'',0,?)",
      )
      .run(
        chat,
        id,
        "[Original message not retained; open this message in WhatsApp for context.]",
        Date.now(),
      );
    const previous = this.db
      .prepare("SELECT reaction_at FROM messages WHERE chat=? AND id=?")
      .get(chat, id);
    if (previous.reaction_at > at) return;
    this.db
      .prepare(
        "UPDATE messages SET pinned=?,pin_seen=1,handled=0,revision=revision+1 WHERE chat=? AND id=? AND pinned<>?",
      )
      .run(pinned ? 1 : 0, chat, id, pinned ? 1 : 0);
    this.db
      .prepare("UPDATE messages SET reaction_at=? WHERE chat=? AND id=?")
      .run(at, chat, id);
  }
  answer(chat, id) {
    if (!this.allowed(chat)) return;
    this.db
      .prepare(
        "UPDATE messages SET answered=1,handled=0,revision=revision+1 WHERE chat=? AND id=? AND answered=0 AND (mention=1 OR reply=1)",
      )
      .run(chat, id);
  }
  prune() {
    this.db
      .prepare("DELETE FROM messages WHERE at<?")
      .run(Date.now() - 30 * 86400000);
  }
  pending() {
    this.prune();
    return this.db
      .prepare(
        "SELECT m.*,c.name AS chat_name FROM messages m JOIN chats c ON c.id=m.chat WHERE (c.selected=1 OR ?) AND handled=0 AND (?=0 OR mention=1 OR reply=1 OR pin_seen=1) ORDER BY at LIMIT 50",
      )
      .all(this.allChats ? 1 : 0, this.allChats ? 1 : 0);
  }
  history(chat) {
    this.prune();
    return this.db
      .prepare(
        "SELECT m.* FROM messages m JOIN chats c ON c.id=m.chat WHERE (c.selected=1 OR ?) AND m.chat=? ORDER BY at DESC LIMIT 50",
      )
      .all(this.allChats ? 1 : 0, chat);
  }
  ack(items) {
    if (!Array.isArray(items) || items.length > 50)
      throw new Error("Invalid items");
    for (const m of items) {
      if (typeof m.chat !== "string" || typeof m.id !== "string")
        throw new Error("Invalid message");
      if (this.allChats && !Number.isInteger(m.revision))
        throw new Error("revision required");
      this.db
        .prepare(
          "UPDATE messages SET handled=1 WHERE chat=? AND id=? AND (? IS NULL OR revision=?)",
        )
        .run(m.chat, m.id, m.revision ?? null, m.revision ?? null);
    }
  }
}
