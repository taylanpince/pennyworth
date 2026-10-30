import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Google Cloud for Engineer jobs (D-48, D-53). The sign-in is plain `gcloud auth application-default
 * login` (scripts/gcloud-auth.sh): the user's own access, cloud-platform. Narrower scopes on gcloud's
 * client got the sign-in blocked by Google's app policy (2026-10-30). A job never gets the refresh
 * token: the runner hands it a one-hour access token in a file its gcloud reads
 * (auth/access_token_file). Keeping to reads is the prompt's rule, and the user's IAM roles.
 */
export class GcpAuthError extends Error {
  constructor(message, state = "expired") {
    super(message);
    this.state = state;
  }
}

/** A one-hour access token from the sign-in's refresh token: { token, expiresAt }. */
export async function accessToken(credentialsFile, fetchImpl = fetch) {
  if (!existsSync(credentialsFile)) throw new GcpAuthError("Google Cloud isn't signed in for Pennyworth (run scripts/gcloud-auth.sh)", "missing");
  const c = JSON.parse(readFileSync(credentialsFile, "utf8"));
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refresh_token, client_id: c.client_id, client_secret: c.client_secret ?? "" });
  const res = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", body, signal: AbortSignal.timeout(15_000) });
  const json = await res.json().catch(() => ({}));
  if (typeof json.access_token === "string" && json.access_token) return { token: json.access_token, expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000 };
  if (res.status >= 500) throw new GcpAuthError(`Google's token endpoint answered ${res.status}`, "unavailable");
  const detail = String(json.error_description ?? "");
  if (/rapt|reauth/i.test(detail)) throw new GcpAuthError("the Google Cloud session ended (16-hour reauth): run scripts/gcloud-auth.sh");
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
    write(await accessToken(credentialsFile, fetchImpl));
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
          accessToken(credentialsFile, fetchImpl).then(write, (err) => log("gcp token refresh failed", { err: String(err.message ?? err).slice(0, 200) }));
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
