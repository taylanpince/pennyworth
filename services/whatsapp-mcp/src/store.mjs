import { DatabaseSync } from "node:sqlite";
export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,name TEXT NOT NULL,selected INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS messages(chat TEXT,id TEXT,text TEXT,sender TEXT,own INTEGER,at INTEGER,handled INTEGER DEFAULT 0,PRIMARY KEY(chat,id));`,
    );
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
    if (
      !this.db
        .prepare("SELECT id FROM chats WHERE id=? AND selected=1")
        .get(m.chat)
    )
      return;
    if (!m.id || !m.text || m.text.length > 20000) return;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO messages(chat,id,text,sender,own,at) VALUES(?,?,?,?,?,?)",
      )
      .run(m.chat, m.id, m.text, m.sender || "", m.own ? 1 : 0, m.at);
    this.db
      .prepare("DELETE FROM messages WHERE at<?")
      .run(Date.now() - 30 * 86400000);
  }
  prune() {
    this.db.prepare("DELETE FROM messages WHERE at<?").run(Date.now() - 30 * 86400000);
  }
  pending() {
    this.prune();
    return this.db
      .prepare(
        "SELECT m.*,c.name AS chat_name FROM messages m JOIN chats c ON c.id=m.chat WHERE c.selected=1 AND handled=0 ORDER BY at LIMIT 50",
      )
      .all();
  }
  history(chat) {
    this.prune();
    return this.db
      .prepare(
        "SELECT m.* FROM messages m JOIN chats c ON c.id=m.chat WHERE c.selected=1 AND m.chat=? ORDER BY at DESC LIMIT 50",
      )
      .all(chat);
  }
  ack(items) {
    if (!Array.isArray(items) || items.length > 50)
      throw new Error("Invalid items");
    for (const m of items) {
      if (typeof m.chat !== "string" || typeof m.id !== "string")
        throw new Error("Invalid message");
      this.db
        .prepare("UPDATE messages SET handled=1 WHERE chat=? AND id=?")
        .run(m.chat, m.id);
    }
  }
}
