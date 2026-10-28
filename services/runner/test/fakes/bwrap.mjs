// bwrap … -- … → … (the job's wrapper that hides the gcloud sign-ins, D-48)
import { exec, log } from "./lib.mjs";

const i = process.argv.indexOf("--");
log("bwrap", process.argv.slice(2, i));
exec(process.argv.slice(i + 1));
