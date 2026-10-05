import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { type Db, openDb } from "./db/db.js";
import { MeetingService } from "./meetings/service.js";
import type { PaperclipApi } from "./paperclip/api.js";
import { HttpPaperclipApi } from "./paperclip/http.js";
import { TaskService } from "./paperclip/tasks.js";
import { Router } from "./routing/routing.js";
import { SourceStore } from "./sources/store.js";
import { TranscriptScanner } from "./sources/transcripts.js";
import type { Logger } from "./util/log.js";
import { Vault } from "./vault/vault.js";

export interface App {
  cfg: Config;
  db: Db;
  vault: Vault;
  meetings: MeetingService;
  paperclip?: PaperclipApi;
  log: Logger;
}

export function paperclipFromConfig(cfg: Config, log: Logger): PaperclipApi | undefined {
  const { company_id, api_key_file, base_url } = cfg.paperclip;
  if (!company_id || !api_key_file) {
    log.warn("paperclip.company_id / api_key_file not set: tasks are queued locally until configured");
    return undefined;
  }
  if (!existsSync(api_key_file)) {
    log.warn({ api_key_file }, "Paperclip API key file missing: tasks are queued locally");
    return undefined;
  }
  const key = readFileSync(api_key_file, "utf8").trim();
  if (!key) {
    log.warn("Paperclip API key file is empty: tasks are queued locally until scripts/paperclip-setup.mjs runs");
    return undefined;
  }
  return new HttpPaperclipApi(base_url, company_id, key);
}

export function createApp(cfg: Config, log: Logger, overrides: { db?: Db; paperclip?: PaperclipApi | null; now?: () => number } = {}): App {
  const db = overrides.db ?? openDb(cfg.data.db_path);
  const paperclip = overrides.paperclip === null ? undefined : (overrides.paperclip ?? paperclipFromConfig(cfg, log));
  const store = new SourceStore(db);
  const scanner = new TranscriptScanner(cfg, store, overrides.now);
  const vault = new Vault(cfg.vault);
  const router = new Router(cfg, db, vault);
  const tasks = new TaskService(db, paperclip, log);
  const meetings = new MeetingService(cfg, db, store, scanner, vault, router, tasks, log);
  return { cfg, db, vault, meetings, paperclip, log };
}

export async function healthChecks(app: App): Promise<{ ok: boolean; checks: Record<string, { ok: boolean; detail?: string }> }> {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  try {
    app.db.exec("CREATE TABLE IF NOT EXISTS _health (ts TEXT); DELETE FROM _health; INSERT INTO _health VALUES (datetime('now'));");
    checks.sqlite_writable = { ok: true };
  } catch (err) {
    checks.sqlite_writable = { ok: false, detail: String(err) };
  }
  const roots = app.cfg.transcripts.roots.map((r) => {
    try {
      accessSync(r, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
  checks.transcripts_readable = { ok: roots.every(Boolean), detail: roots.every(Boolean) ? undefined : "one or more transcript roots unreadable" };
  checks.vault_available = { ok: app.vault.available() };
  const unwritable = app.cfg.vault.write_roots.filter((dir) => {
    try {
      accessSync(join(app.cfg.vault.root, dir), constants.W_OK);
      return false;
    } catch {
      return true;
    }
  });
  checks.vault_writable = { ok: unwritable.length === 0, detail: unwritable.length ? `not writable: ${unwritable.join(", ")}` : undefined };
  if (app.paperclip) {
    checks.paperclip_api = { ok: await app.paperclip.ping() };
  } else {
    checks.paperclip_api = { ok: false, detail: "not configured" };
  }
  const required = ["sqlite_writable", "transcripts_readable", "vault_available", "vault_writable"];
  return { ok: required.every((k) => checks[k]?.ok), checks };
}
