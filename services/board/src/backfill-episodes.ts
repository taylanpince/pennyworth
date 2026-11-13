// One-off (D-61): record the crew's finished work of the last N days (default 60) as past tasks, for
// installs from before memory existed. Idempotent: tasks already recorded are skipped.
//
//   docker compose exec board node --disable-warning=ExperimentalWarning dist/src/backfill-episodes.js [days]
import { loadConfig } from "./config.js";
import { backfillEpisodes } from "./memoryapi.js";
import { Paperclip } from "./paperclip.js";
import { Store } from "./store.js";

const days = Number(process.argv[2] ?? 60);
if (!Number.isInteger(days) || days < 1 || days > 365) {
  console.error("usage: backfill-episodes.js [days, 1-365]");
  process.exit(2);
}
const cfg = loadConfig();
const store = new Store(cfg.dbPath);
try {
  const added = await backfillEpisodes(new Paperclip(cfg.paperclipUrl, cfg.companyId, cfg.boardKey), store.memory, days);
  console.log(`Recorded ${added} past task${added === 1 ? "" : "s"} from the last ${days} days.`);
} finally {
  store.close();
}
