/**
 * A Slack permalink as a slack:// link the desktop app opens directly (the web link opens a tab
 * that then launches the app). Undefined for other links and for Slack hosts with no known ID.
 */
export function slackAppLink(href: string, teams: Record<string, string>): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  const team = url.protocol === "https:" ? teams[url.hostname.toLowerCase()] : undefined;
  const m = /^\/archives\/([A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?\/?$/.exec(url.pathname);
  if (!team || !m) return undefined;
  const q = new URLSearchParams({ team, id: m[1]! });
  if (m[2]) q.set("message", `${m[2]}.${m[3]}`);
  const thread = url.searchParams.get("thread_ts");
  if (m[2] && thread && /^\d{10}\.\d{6}$/.test(thread)) q.set("thread_ts", thread);
  q.set("host", "slack.com");
  return `slack://channel?${q}`;
}
