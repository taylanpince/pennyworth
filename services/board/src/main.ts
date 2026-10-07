import pino from "pino";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Paperclip } from "./paperclip.js";
import { Store, localDate } from "./store.js";

const cfg = loadConfig();
const log = pino({ level: cfg.logLevel, redact: { paths: ["authorization", "*.authorization", "key", "*.key"], censor: "[redacted]" }, base: { svc: "board" } });
const store = new Store(cfg.dbPath);
const paperclip = new Paperclip(cfg.paperclipUrl, cfg.companyId, cfg.boardKey);

function rollover() {
  try {
    const moved = store.rollover(localDate(cfg.timezone));
    if (moved) log.info({ moved }, "midnight rollover: Tomorrow → Today");
  } catch (err) {
    log.error({ err: String(err) }, "rollover failed");
  }
}
rollover();
setInterval(rollover, 60_000).unref();

const common = { paperclip, store, log, staticDir: cfg.staticDir, timezone: cfg.timezone, lan: cfg.lan };
const server = createApp({ ...common, allowedHosts: cfg.allowedHosts, mode: "local" });
server.listen(cfg.port, "0.0.0.0", () => log.info({ port: cfg.port, hosts: cfg.allowedHosts }, "board listening"));
// Phones on the home network (D-23): a separate port, paired devices only.
const lan = cfg.lan && createApp({ ...common, allowedHosts: cfg.lan.hosts, mode: "lan" });
if (lan && cfg.lan) lan.listen(cfg.lan.port, "0.0.0.0", () => log.info({ port: cfg.lan!.port, hosts: cfg.lan!.hosts, clients: cfg.lan!.clients }, "LAN board listening"));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close();
    lan?.close();
    store.close();
    process.exit(0);
  });
}
