// Parsing of the user's replies on review tasks. Deterministic and lenient: accepts
// "pick 2", "2", "option #2", "route polygon/x.md", or natural phrasing like
// "route these 1-1 notes with Vojtech to polygon/oms/Vojtech 1-1".

export type MatchCommand = { kind: "pick"; choice: string } | { kind: "ignore" };
export type RouteCommand = { kind: "route"; targets: string[] } | { kind: "none" };

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

function cleanTarget(raw: string): string | undefined {
  let t = raw
    .trim()
    .replace(/^(?:the\s+)?(?:note\s+)?/i, "")
    .replace(/^[`'"“‘[(]+|[`'"”’\])]+$/g, "")
    .replace(/^\[\[|\]\]$/g, "")
    .replace(/[.,;:!?]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  t = t.replace(/^[`'"]+|[`'"]+$/g, "").trim();
  if (!t.includes("/") || t.startsWith("/") || t.includes("..")) return undefined;
  return t.toLowerCase().endsWith(".md") ? t : `${t}.md`;
}

export function parseRouteCommand(body: string): RouteCommand | undefined {
  const targets: string[] = [];
  for (const raw of strip(body).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^route\s+none\b|\b(don'?t|do not)\s+route\b|\broute\b.*\bnowhere\b|^no (project )?note\b/i.test(line)) return { kind: "none" };
    const wiki = [...line.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => m[1]!);
    if (!/\b(route|append|log|file|put)\b/i.test(line) && !(wiki.length && /\broute\b/i.test(body))) continue;
    const candidates = wiki.length ? wiki : [/\bto\s+(.+)$/i.exec(line)?.[1] ?? /^route\s+(.+)$/i.exec(line)?.[1] ?? ""];
    for (const c of candidates) {
      const t = cleanTarget(c);
      if (t && !targets.includes(t)) targets.push(t);
    }
  }
  return targets.length ? { kind: "route", targets } : undefined;
}
