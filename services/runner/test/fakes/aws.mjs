// aws configure export-credentials --profile <p> … → one-hour credentials named after the profile;
// any other command (a change through `pennyworth aws`) is logged with the key it ran with.
import { log } from "./lib.mjs";

const args = process.argv.slice(2);
if (args[0] === "configure" && args[1] === "export-credentials") {
  const profile = args[args.indexOf("--profile") + 1];
  console.log(JSON.stringify({ Version: 1, AccessKeyId: `AKIA-${profile}`, SecretAccessKey: "s", SessionToken: "t", Expiration: new Date(Date.now() + 3600_000).toISOString() }));
  process.exit(0);
}
log("aws", { args, key: process.env.AWS_ACCESS_KEY_ID, cwd: process.cwd() });
console.log(JSON.stringify({ service: { serviceName: "api", status: "ACTIVE" } }));
