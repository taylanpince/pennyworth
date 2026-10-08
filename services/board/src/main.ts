import pino from "pino";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Paperclip } from "./paperclip.js";
import { Store, localDate } from "./store.js";

const cfg = loadConfig();
const log = pino({ level: cfg.logLevel, redact: { paths: ["authorization", "*.authorization", "key", "*.key"], censor: "[redacted]" }, base: { svc: "board" } });
const store = new Store(cfg.dbPath);
const paperclip = new Paperclip(cfg.paperclipUrl, cfg.companyId, cfg.boardKey);

/** Every minute: Tomorrow → Today at midnight, then any scheduled moves that are due (D-25), on top. */
function rollover() {
  try {
    const today = localDate(cfg.timezone);
    const moved = store.rollover(today);
    if (moved) log.info({ moved }, "midnight rollover: Tomorrow → Today");
    const scheduled = store.applySchedules(today);
    if (scheduled.length) log.info({ moved: scheduled.length }, "scheduled moves applied");
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

// The tasks bridge and the runner (D-25): bearer token, /internal/ only. Not published beyond loopback.
const internal = cfg.internal && createApp({ ...common, allowedHosts: cfg.internal.hosts, mode: "internal", internalToken: cfg.internal.token });
if (internal && cfg.internal) internal.listen(cfg.internal.port, "0.0.0.0", () => log.info({ port: cfg.internal!.port }, "internal API listening"));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close();
    lan?.close();
    internal?.close();
    store.close();
    process.exit(0);
  });
}
