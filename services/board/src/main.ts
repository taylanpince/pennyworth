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

const server = createApp({ paperclip, store, log, allowedHosts: cfg.allowedHosts, staticDir: cfg.staticDir, timezone: cfg.timezone });
server.listen(cfg.port, "0.0.0.0", () => log.info({ port: cfg.port, hosts: cfg.allowedHosts }, "board listening"));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close();
    store.close();
    process.exit(0);
  });
}
