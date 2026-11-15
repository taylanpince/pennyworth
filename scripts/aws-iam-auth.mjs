// Interactive IAM key setup; invoked by aws-auth.sh only when aws.auth is iam.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../services/runner/src/config.mjs";
import { roleCredentials, writeProfiles } from "../services/runner/src/aws.mjs";

process.umask(0o077);
const { aws } = loadConfig();
if (aws.auth !== "iam" || !aws.accounts.length || aws.accounts.some((a) => !a.readRole || !a.region)) {
  console.error("Set aws.auth: iam and aws.accounts with name, id, region and read_role in config/runner.yaml first.");
  process.exit(1);
}
writeProfiles(aws);
chmodSync(aws.home, 0o700);
const credentials = join(aws.home, ".aws/credentials");
const env = { PATH: process.env.PATH, HOME: aws.home, AWS_CONFIG_FILE: join(aws.home, ".aws/config"), AWS_SHARED_CREDENTIALS_FILE: credentials, AWS_EC2_METADATA_DISABLED: "true" };
console.log("Enter the dedicated read-only IAM user's keys. Temporary credentials retain this user's permissions; do not use an admin user's keys.");
for (const account of aws.accounts) {
  console.log(`Configuring ${account.name} (${account.id})`);
  const result = spawnSync("aws", ["configure", "--profile", `${account.name}.read`], { env, stdio: "inherit" });
  if (existsSync(credentials)) chmodSync(credentials, 0o600);
  if (result.error || result.status !== 0) process.exit(1);
  try {
    await roleCredentials({ aws, account, kind: "read" });
    console.log(`${account.name}: verified IAM user and one-hour temporary credentials`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
