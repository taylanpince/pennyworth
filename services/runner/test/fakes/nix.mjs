// nix develop <flake>#<shell> --command … → …
import { exec, log } from "./lib.mjs";

const i = process.argv.indexOf("--command");
log("nix", process.argv.slice(2, i));
exec(process.argv.slice(i + 1));
