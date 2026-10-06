// Parsing of the user's replies on review tasks. Deterministic and lenient: accepts
// "pick 2", "2", "option #2" or "ignore".

export type MatchCommand = { kind: "pick"; choice: string } | { kind: "ignore" };

const strip = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");

export function parseMatchCommand(body: string): MatchCommand | undefined {
  const lines = strip(body).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of [...lines].reverse()) {
    if (/^(ignore|skip|none of (these|them)|not a meeting)\b/i.test(line)) return { kind: "ignore" };
    const pick = /^(?:pick|choose|select|option|it'?s|it is|number|use)?\s*#?\s*(\d{1,2})\s*[.!)]?$/i.exec(line);
    if (pick) return { kind: "pick", choice: pick[1]! };
    const byId = /^(?:pick|choose|select|use)\s+(\S{6,})$/i.exec(line);
    if (byId) return { kind: "pick", choice: byId[1]! };
  }
  return undefined;
}
