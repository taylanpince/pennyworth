// Token helpers for title and name comparison.

export function normalizeTokens(text: string, stopwords: Set<string>): string[] {
  const tokens = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !stopwords.has(t) && !/^\d+$/.test(t));
  return [...new Set(tokens)];
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Tolerant token equality: exact, shared prefix (≥4 chars), or one edit for longer words. */
export function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length >= 4 && long.startsWith(short)) return true;
  return short.length >= 5 && editDistanceAtMostOne(a, b);
}

/** Similarity in [0,1]: max of Dice coefficient and containment of `hint` in `target`. */
export function titleSimilarity(hint: string[], target: string[]): number {
  if (hint.length === 0 || target.length === 0) return 0;
  const used = new Set<number>();
  let common = 0;
  for (const h of hint) {
    const idx = target.findIndex((t, i) => !used.has(i) && tokensMatch(h, t));
    if (idx >= 0) {
      used.add(idx);
      common++;
    }
  }
  const dice = (2 * common) / (hint.length + target.length);
  const containment = common / hint.length;
  return Math.max(dice, containment);
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive whole-word presence test. */
export function containsWord(haystackLower: string, word: string): boolean {
  if (word.length < 3) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(word.toLowerCase())}($|[^a-z0-9])`).test(haystackLower);
}
