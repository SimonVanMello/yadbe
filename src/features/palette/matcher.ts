/** A string prepared once for matching, so that a keystroke never lowercases 10 000 names again. */
export interface Searchable {
  /** What is displayed and highlighted (`public.orders`). */
  text: string;
  /** `text` in lower case. */
  lower: string;
  /** Where the name starts in `text`, after the qualifying schema (`public.` → 7). */
  nameStart: number;
}

export interface Hit<T extends Searchable> {
  item: T;
  score: number;
  /** Matched character indices in `item.text`. */
  indices: number[];
}

export function searchable(text: string, nameStart = 0): Searchable {
  return { text, lower: text.toLowerCase(), nameStart };
}

const BOUNDARY_CODES = new Set([32, 47, 92, 95, 46, 64, 58, 45, 40]); // space / \ _ . @ : - (

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text.charCodeAt(index - 1);
  if (BOUNDARY_CODES.has(previous)) return true;
  // camelCase: `orderItems` has a word start at `I`.
  const current = text.charCodeAt(index);
  return previous >= 97 && previous <= 122 && current >= 65 && current <= 90;
}

const MAX_NEEDLE = 64;
const limits = new Int32Array(MAX_NEEDLE);

/** The characters of a query that take part in matching: spaces and case do not. */
export function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, '').toLowerCase().slice(0, MAX_NEEDLE);
}

/**
 * Case-insensitive subsequence match of `needle` (already normalized) in `item`, or `null`.
 *
 * Every needle character is placed on the leftmost occurrence that still lets the rest fit,
 * or on a word boundary when one exists before the last position that fits: a match that exists
 * is never lost to a boundary that leaves no room for the end of the query. Consecutive
 * characters, word starts and prefixes of the name score higher, gaps cost a little, and a
 * match that lies in the name rather than in the schema wins ties (`ord` → `public.orders`
 * before `orders_archive.users`). `out` receives the matched indices when given.
 */
export function scoreMatch(needle: string, item: Searchable, out: number[] | null): number | null {
  const { text, lower, nameStart } = item;
  const length = needle.length;
  if (length === 0) return 0;
  // Right to left: the last position each character can take. Fails exactly when no match exists.
  let to = lower.length;
  for (let k = length - 1; k >= 0; k--) {
    // `lastIndexOf` reads a negative start as 0: nothing is left to the left of the text.
    const at = to === 0 ? -1 : lower.lastIndexOf(needle.charAt(k), to - 1);
    if (at === -1) return null;
    limits[k] = at;
    to = at;
  }
  let score = 0;
  let previous = -2;
  let first = -1;
  for (let k = 0; k < length; k++) {
    const char = needle.charAt(k);
    const limit = limits[k] ?? 0;
    let index = lower.indexOf(char, previous + 1);
    if (index !== previous + 1) {
      let candidate = index;
      while (candidate !== -1 && candidate <= limit && !isBoundary(text, candidate)) {
        candidate = lower.indexOf(char, candidate + 1);
      }
      if (candidate !== -1 && candidate <= limit) index = candidate;
    }
    if (index === previous + 1) score += 8;
    else if (previous >= 0) score -= Math.min(index - previous - 1, 6);
    if (isBoundary(text, index)) score += 6;
    if (index === 0 || (nameStart > 0 && index === nameStart)) score += 4;
    score += 1;
    if (first === -1) first = index;
    out?.push(index);
    previous = index;
  }
  if (nameStart > 0 && first >= nameStart) score += 6;
  // The whole name typed: `orders` is `orders`, not the first of its prefixes.
  if (lower.length - nameStart === length && first === nameStart && previous === lower.length - 1) {
    score += 20;
  }
  // Shorter texts win ties.
  return score - text.length * 0.01;
}

/** Results kept for a query: nobody reads past a few screens, and the total is still counted. */
export const MAX_HITS = 150;

export interface SearchResult<T extends Searchable> {
  hits: Hit<T>[];
  /** How many items match, whatever the number of hits kept. */
  total: number;
}

export interface Searcher<T extends Searchable> {
  search(query: string, limit?: number, boost?: (item: T) => number): SearchResult<T>;
}

/**
 * Search over a fixed list, incremental: a query that extends the previous one (the next
 * keystroke) only looks at what the previous one matched, since whatever matches `abc` as a
 * subsequence also matches `ab`. The best `limit` are kept by insertion into a sorted window, not
 * by sorting every match.
 */
export function createSearcher<T extends Searchable>(items: readonly T[]): Searcher<T> {
  let lastNeedle = '';
  let lastCandidates: number[] | null = null;
  return {
    search(query, limit = MAX_HITS, boost) {
      const needle = normalizeQuery(query);
      if (needle === '') {
        lastNeedle = '';
        lastCandidates = null;
        return {
          hits: items.slice(0, limit).map((item) => ({ item, score: 0, indices: [] })),
          total: items.length,
        };
      }
      const narrowing =
        lastCandidates !== null && lastNeedle !== '' && needle.startsWith(lastNeedle);
      const matched: number[] = [];
      const topIndex: number[] = [];
      const topScore: number[] = [];
      const visit = (index: number) => {
        const item = items[index];
        if (!item) return;
        const base = scoreMatch(needle, item, null);
        if (base === null) return;
        matched.push(index);
        const score = base + (boost ? boost(item) : 0);
        if (topScore.length === limit && score <= (topScore[limit - 1] ?? -Infinity)) return;
        // Insert after every score that is at least as good: ties keep the list's order.
        let low = 0;
        let high = topScore.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if ((topScore[mid] ?? 0) >= score) low = mid + 1;
          else high = mid;
        }
        topScore.splice(low, 0, score);
        topIndex.splice(low, 0, index);
        if (topScore.length > limit) {
          topScore.pop();
          topIndex.pop();
        }
      };
      if (narrowing && lastCandidates) for (const index of lastCandidates) visit(index);
      else for (let index = 0; index < items.length; index++) visit(index);
      lastNeedle = needle;
      lastCandidates = matched;
      const hits: Hit<T>[] = [];
      topIndex.forEach((index, rank) => {
        const item = items[index];
        if (!item) return;
        const indices: number[] = [];
        scoreMatch(needle, item, indices);
        hits.push({ item, score: topScore[rank] ?? 0, indices });
      });
      return { hits, total: matched.length };
    },
  };
}
