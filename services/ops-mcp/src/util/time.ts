// Timezone helpers built on Intl, so no tz database dependency is needed.

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(tz, f);
  }
  return f;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function wallClock(epochMs: number, tz: string): WallClock {
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function offsetMs(epochMs: number, tz: string): number {
  const w = wallClock(epochMs, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Interpret a wall-clock time in `tz` and return epoch milliseconds. */
export function zonedToEpoch(w: WallClock, tz: string): number {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** Local date and time strings for display and note paths. */
export function localParts(epochMs: number, tz: string): { date: string; time: string; compact: string; year: string; month: string } {
  const w = wallClock(epochMs, tz);
  return {
    date: `${w.year}-${pad(w.month)}-${pad(w.day)}`,
    time: `${pad(w.hour)}:${pad(w.minute)}`,
    compact: `${pad(w.hour)}${pad(w.minute)}`,
    year: String(w.year),
    month: pad(w.month),
  };
}

export const toIso = (epochMs: number): string => new Date(epochMs).toISOString();

export const MINUTE = 60_000;
