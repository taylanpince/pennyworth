// Parsing of the user's replies on review tasks. Deterministic and lenient: accepts
// "pick 2", "2", "option #2", "ignore", or a note that the meeting was not on the calendar
// ("this was an impromptu call with …"), which publishes it without an event.

export type MatchCommand = { kind: "pick"; choice: string } | { kind: "ignore" } | { kind: "unscheduled"; note: string };

const strip = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");

const UNSCHEDULED =
  /\b(impromptu|unscheduled|unplanned|spontaneous|ad[- ]?hoc|off[- ]calendar|(not|wasn'?t|isn'?t) (on|in) (the|my) calendar|no (calendar )?(event|invite|entry)|(not|wasn'?t) scheduled|no meeting (was )?scheduled)\b/i;

export function parseMatchCommand(body: string): MatchCommand | undefined {
  const text = strip(body).trim();
  if (UNSCHEDULED.test(text)) return { kind: "unscheduled", note: text.slice(0, 2000) };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of [...lines].reverse()) {
    if (/^(ignore|skip|none of (these|them)|not a meeting)\b/i.test(line)) return { kind: "ignore" };
    const pick = /^(?:pick|choose|select|option|it'?s|it is|number|use)?\s*#?\s*(\d{1,2})\s*[.!)]?$/i.exec(line);
    if (pick) return { kind: "pick", choice: pick[1]! };
    const byId = /^(?:pick|choose|select|use)\s+(\S{6,})$/i.exec(line);
    if (byId) return { kind: "pick", choice: byId[1]! };
  }
  return undefined;
}
