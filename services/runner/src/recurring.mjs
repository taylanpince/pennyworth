// Recurring tasks (D-25): the runner claims due runs from the board, adds the period's GitHub
// activity to the user's task for it, and starts the Assistant. The GitHub part is fixed, read-only
// GraphQL with your gh login (like reviews.mjs); nothing is written to GitHub.
import { readFileSync } from "node:fs";

/** The board's internal API (bearer token), for claiming runs and reporting whether they started. */
export class Board {
  constructor(url, tokenFile) {
    this.url = url.replace(/\/$/, "");
    this.token = readFileSync(tokenFile, "utf8").trim();
  }

  async post(path, body = {}) {
    const res = await fetch(`${this.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`board POST ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  async claim() {
    return (await this.post("/internal/recurring/claim")).runs ?? [];
  }

  runState(run, state) {
    return this.post(`/internal/recurring/runs/${run.definitionId}/${run.occurrence}`, { state });
  }
}

const LIMIT = 40;

/** Search strings for one repository and window (ISO instants; GitHub accepts date-time ranges). */
export function activitySearches(repo, since, until) {
  const range = `${since.replace(/\.\d{3}Z$/, "Z")}..${until.replace(/\.\d{3}Z$/, "Z")}`;
  return {
    merged: `repo:${repo} is:pr is:merged merged:${range}`,
    opened: `repo:${repo} is:pr is:open created:${range}`,
    issuesOpened: `repo:${repo} is:issue created:${range}`,
    issuesClosed: `repo:${repo} is:issue is:closed closed:${range}`,
  };
}

export const ACTIVITY_QUERY = `query($owner: String!, $name: String!, $since: GitTimestamp!, $until: GitTimestamp!, $merged: String!, $opened: String!, $issuesOpened: String!, $issuesClosed: String!) {
  merged: search(query: $merged, type: ISSUE, first: ${LIMIT}) { issueCount nodes { ... on PullRequest { number title url author { login } } } }
  opened: search(query: $opened, type: ISSUE, first: ${LIMIT}) { issueCount nodes { ... on PullRequest { number title url isDraft author { login } } } }
  issuesOpened: search(query: $issuesOpened, type: ISSUE, first: ${LIMIT}) { issueCount nodes { ... on Issue { number title url author { login } } } }
  issuesClosed: search(query: $issuesClosed, type: ISSUE, first: ${LIMIT}) { issueCount nodes { ... on Issue { number title url } } }
  repository(owner: $owner, name: $name) {
    releases(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { name tagName url publishedAt isDraft } }
    defaultBranchRef { name target { ... on Commit { history(since: $since, until: $until, first: ${LIMIT}) { totalCount nodes { messageHeadline url author { name user { login } } associatedPullRequests(first: 1) { nodes { number merged } } } } } } }
  }
}`;

// Titles are other people's text: no links, HTML, comments or line breaks of their own.
const clean = (s) => String(s ?? "").replace(/<!--|-->/g, "").replace(/[\[\]<>`|]/g, "").replace(/([*_])/g, "\\$1").replace(/\s+/g, " ").trim().slice(0, 160);

function list(label, result, item) {
  const nodes = (result?.nodes ?? []).filter((n) => n?.url);
  if (!nodes.length) return [];
  const more = (result.issueCount ?? nodes.length) - nodes.length;
  return [`- **${label} (${result.issueCount ?? nodes.length}):**`, ...nodes.map((n) => `  - ${item(n)}`), ...(more > 0 ? [`  - …and ${more} more`] : [])];
}

const by = (n) => (n.author?.login ? ` by ${clean(n.author.login)}` : "");
const ref = (n) => `[#${n.number}](${n.url}) ${clean(n.title)}`;

/** Commits on the default branch that didn't come in through a merged PR (direct pushes). */
function directCommits(data) {
  const branch = data?.repository?.defaultBranchRef;
  const history = branch?.target?.history;
  const direct = (history?.nodes ?? []).filter((c) => !(c.associatedPullRequests?.nodes ?? []).some((pr) => pr.merged));
  if (!direct.length) return [];
  const author = (c) => c.author?.user?.login ?? c.author?.name;
  const more = history.totalCount > history.nodes.length ? [`  - …and more (${history.totalCount} commits in all)`] : [];
  return [`- **Pushed to ${clean(branch.name)} without a PR (${direct.length}):**`, ...direct.map((c) => `  - [${clean(c.messageHeadline)}](${c.url})${author(c) ? ` by ${clean(author(c))}` : ""}`), ...more];
}

/** One repository's section of the comment, from the GraphQL result (or the error reading it). */
export function formatRepo(repo, data, since, until, err) {
  if (err) return `### ${repo}\n_Couldn't read this repository: ${clean(err).slice(0, 200)}_`;
  const releases = (data?.repository?.releases?.nodes ?? []).filter((r) => !r.isDraft && r.publishedAt && r.publishedAt >= since && r.publishedAt < until);
  const lines = [
    ...list("Merged PRs", data?.merged, (n) => `${ref(n)}${by(n)}`),
    ...list("Opened PRs, still open", data?.opened, (n) => `${ref(n)}${by(n)}${n.isDraft ? " (draft)" : ""}`),
    ...directCommits(data),
    ...(releases.length ? [`- **Releases (${releases.length}):**`, ...releases.map((r) => `  - [${clean(r.name || r.tagName)}](${r.url})`)] : []),
    ...list("Issues opened", data?.issuesOpened, (n) => `${ref(n)}${by(n)}`),
    ...list("Issues closed", data?.issuesClosed, ref),
  ];
  return `### ${repo}\n${lines.length ? lines.join("\n") : "_Nothing in this period._"}`;
}

/** The comment the runner adds to the user's task for the period. */
export function activityComment(run, sections) {
  return [`**GitHub activity, ${run.sinceLocal} to ${run.untilLocal}** (${run.timezone}), for the Assistant to draft from.`, ...sections].join("\n\n");
}
