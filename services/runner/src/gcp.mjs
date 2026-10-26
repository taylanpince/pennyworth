import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Google Cloud for Engineer jobs, read-only (D-48). The sign-in (scripts/gcloud-auth.sh) grants
 * cloud-platform, which gcloud insists on, plus each API's read-only scope. A job never gets that
 * refresh token: the runner refreshes it narrowed to the read-only scopes below and hands the job a
 * one-hour access token in a file its gcloud reads (auth/access_token_file). Google enforces
 * the scope on every call, so writes fail whatever the user's IAM roles allow. APIs without a
 * read-only scope (Secret Manager, KMS, IAM, Cloud SQL, Pub/Sub…) are out of reach entirely.
 */
export const READ_SCOPES = [
  "https://www.googleapis.com/auth/logging.read",
  "https://www.googleapis.com/auth/monitoring.read",
  "https://www.googleapis.com/auth/compute.readonly",
  "https://www.googleapis.com/auth/container.read-only", // the GKE API; kubectl needs userinfo.email, left out on purpose
  "https://www.googleapis.com/auth/run.readonly",
  "https://www.googleapis.com/auth/redis.read-only",
  "https://www.googleapis.com/auth/ndev.clouddns.readonly",
  // Not cloud-platform.read-only or devstorage.read_only: despite the names, some APIs accept them
  // for writes (Agent Registry create/delete, BigQuery jobs that can be DML, liens). Checked against
  // every API in Google's discovery directory.
];

/** What the sign-in asks for: gcloud refuses an application-default login without cloud-platform. */
export const LOGIN_SCOPES = ["https://www.googleapis.com/auth/cloud-platform", ...READ_SCOPES];

export class GcpAuthError extends Error {
  constructor(message, state = "expired") {
    super(message);
    this.state = state;
  }
}

/** A read-only access token from the sign-in's refresh token: { token, expiresAt }. */
export async function readOnlyToken(credentialsFile, fetchImpl = fetch) {
  if (!existsSync(credentialsFile)) throw new GcpAuthError("Google Cloud isn't signed in for Pennyworth (run scripts/gcloud-auth.sh)", "missing");
  const c = JSON.parse(readFileSync(credentialsFile, "utf8"));
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refresh_token, client_id: c.client_id, client_secret: c.client_secret ?? "", scope: READ_SCOPES.join(" ") });
  const res = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", body, signal: AbortSignal.timeout(15_000) });
  const json = await res.json().catch(() => ({}));
  if (typeof json.access_token === "string" && json.access_token) {
    // Never trust a token wider than asked for: a write scope here would undo the whole boundary.
    const granted = String(json.scope ?? "").split(/\s+/).filter(Boolean);
    const extra = granted.filter((s) => !READ_SCOPES.includes(s));
    if (extra.length) throw new GcpAuthError(`Google granted more than read-only (${extra.join(", ")})`, "refused");
    return { token: json.access_token, expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000 };
  }
  if (res.status >= 500) throw new GcpAuthError(`Google's token endpoint answered ${res.status}`, "unavailable");
  const detail = String(json.error_description ?? "");
  if (/rapt|reauth/i.test(detail)) throw new GcpAuthError("the Google Cloud session ended (16-hour reauth): run scripts/gcloud-auth.sh");
  if (json.error === "invalid_scope") throw new GcpAuthError("the sign-in is missing the read-only scopes: run scripts/gcloud-auth.sh again");
  throw new GcpAuthError(`Google refused the sign-in (${json.error ?? res.status}${detail ? `: ${detail}` : ""}): run scripts/gcloud-auth.sh`);
}

/**
 * gcloud for one job: a config directory of its own (CLOUDSDK_CONFIG) whose properties point at the
 * token file, kept fresh while the job runs. Properties rather than CLOUDSDK_AUTH_* variables: Codex
 * drops variables named *TOKEN* from its tool calls. `state` is ok, missing, expired, refused or unavailable; the job runs either way, and the
 * prompt tells the agent what it has. `done()` stops the refresh and removes the token.
 */
export async function gcpSession({ credentialsFile, dir, project, log = () => {}, fetchImpl = fetch, refreshMinutes = 40 }) {
  const config = join(dir, "config");
  const tokenFile = join(dir, "token");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const write = ({ token }) => {
    const tmp = `${tokenFile}.tmp`;
    writeFileSync(tmp, token, { mode: 0o600 });
    renameSync(tmp, tokenFile);
  };
  const properties = (auth) => {
    mkdirSync(join(config, "configurations"), { recursive: true });
    writeFileSync(join(config, "active_config"), "default");
    writeFileSync(
      join(config, "configurations/config_default"),
      ["[core]", "disable_prompts = True", "disable_usage_reporting = True", ...(project ? [`project = ${project}`] : []), ...(auth ? ["[auth]", `access_token_file = ${tokenFile}`] : []), "[component_manager]", "disable_update_check = True", ""].join("\n"),
    );
  };
  const env = { CLOUDSDK_CONFIG: config };
  let state = "ok";
  let detail;
  try {
    write(await readOnlyToken(credentialsFile, fetchImpl));
    properties(true);
  } catch (err) {
    properties(false);
    if (!(err instanceof GcpAuthError)) throw err;
    ({ state } = err);
    detail = err.message;
  }
  const timer =
    state === "ok"
      ? setInterval(() => {
          readOnlyToken(credentialsFile, fetchImpl).then(write, (err) => log("gcp token refresh failed", { err: String(err.message ?? err).slice(0, 200) }));
        }, refreshMinutes * 60_000)
      : undefined;
  timer?.unref();
  return {
    state,
    detail,
    env,
    root: dir,
    done() {
      if (timer) clearInterval(timer);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
