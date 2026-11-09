// Load a database dump into Paperclip's embedded Postgres with Paperclip's own restore (D-58).
// Run inside the paperclip container by scripts/restore.sh:
//   node --import ./server/node_modules/tsx/dist/loader.mjs /tmp/paperclip-restore.mts <dump.sql> [connection]
import { runDatabaseRestore } from "/app/packages/db/src/index.ts";

const [backupFile, connectionString = "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip"] = process.argv.slice(2);
if (!backupFile) throw new Error("usage: paperclip-restore.mts <dump.sql> [connection]");
await runDatabaseRestore({ connectionString, backupFile });
console.log(`restored ${backupFile}`);
