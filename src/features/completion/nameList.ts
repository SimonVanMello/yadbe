/**
 * Names sorted for prefix lookups, and the ranking of how well a name matches what was typed:
 * prefix, then start of a word inside the name (`order_items` for `it`), then letters in order
 * (`oi` for `order_items`), shorter names first.
 */

export interface Ranked {
  id: number;
  name: string;
  score: number;
}

const PREFIX = 3000;
/** Score of a name that starts with what was typed, before the length counts. */
export const PREFIX_SCORE = PREFIX;
const BOUNDARY = 2000;
const FUZZY = 1000;
const LENGTH_CAP = 100;

function isWordChar(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}

/** Whether `name` starts a word at `at`: after a separator, or a capital after a lower-case. */
function startsWord(name: string, at: number): boolean {
  if (at === 0) return true;
  const before = name.charAt(at - 1);
  if (!isWordChar(before)) return true;
  const here = name.charAt(at);
  return before >= 'a' && before <= 'z' && here >= 'A' && here <= 'Z';
}

/**
 * How well `name` matches `query` (already lower-cased): 0 for no match, else a score where a
 * prefix beats a word start, which beats scattered letters, and shorter names beat longer ones.
 * `lower` is the lower-cased `name`.
 */
export function matchScore(name: string, lower: string, query: string): number {
  const shortness = LENGTH_CAP - Math.min(name.length, LENGTH_CAP);
  if (query === '') return PREFIX + shortness;
  if (lower.startsWith(query)) return PREFIX + shortness + (lower === query ? 50 : 0);
  // A word start: the earlier in the name, the better.
  let at = lower.indexOf(query, 1);
  while (at > 0) {
    if (startsWord(name, at)) return BOUNDARY + shortness - Math.min(at, 20);
    at = lower.indexOf(query, at + 1);
  }
  // Letters in order; the fewer the skipped ones, the better.
  let from = 0;
  let gaps = 0;
  for (let i = 0; i < query.length; i++) {
    const found = lower.indexOf(query.charAt(i), from);
    if (found < 0) return 0;
    gaps += found - from;
    from = found + 1;
  }
  return FUZZY + shortness - Math.min(gaps, LENGTH_CAP - 1);
}

/** A set of names, each with an id, sorted by their lower case. Built once, searched often. */
export class NameList {
  readonly lowers: string[];
  readonly names: string[];
  readonly ids: number[];

  constructor(entries: readonly { name: string; id: number }[]) {
    const decorated = entries.map((entry) => ({ ...entry, lower: entry.name.toLowerCase() }));
    decorated.sort((a, b) => (a.lower < b.lower ? -1 : a.lower > b.lower ? 1 : a.id - b.id));
    this.lowers = decorated.map((entry) => entry.lower);
    this.names = decorated.map((entry) => entry.name);
    this.ids = decorated.map((entry) => entry.id);
  }

  get size(): number {
    return this.ids.length;
  }

  /** First position whose lower-cased name is not below `key`. */
  private lowerBound(key: string): number {
    let lo = 0;
    let hi = this.lowers.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.lowers[mid] ?? '') < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The `limit` best matches of `typed`, best first. */
  search(typed: string, limit: number): Ranked[] {
    const query = typed.toLowerCase();
    if (query === '') {
      const count = Math.min(limit, this.size);
      return Array.from({ length: count }, (_, i) => ({
        id: this.ids[i] ?? -1,
        name: this.names[i] ?? '',
        score: PREFIX + LENGTH_CAP - Math.min((this.names[i] ?? '').length, LENGTH_CAP),
      }));
    }
    const lo = this.lowerBound(query);
    let hi = lo;
    while (hi < this.lowers.length && (this.lowers[hi] ?? '').startsWith(query)) hi++;
    const found: (Ranked & { position: number })[] = [];
    for (let i = lo; i < hi; i++) {
      const name = this.names[i] ?? '';
      const exactCase = name.startsWith(typed) ? 5 : 0;
      found.push({
        id: this.ids[i] ?? -1,
        name,
        score: matchScore(name, this.lowers[i] ?? '', query) + exactCase,
        position: i,
      });
    }
    // Enough prefix matches: nothing that ranks below them can show, so no scan of the rest.
    if (found.length < limit) {
      for (let i = 0; i < this.lowers.length; i++) {
        if (i >= lo && i < hi) continue;
        const name = this.names[i] ?? '';
        const score = matchScore(name, this.lowers[i] ?? '', query);
        if (score > 0) found.push({ id: this.ids[i] ?? -1, name, score, position: i });
      }
    }
    found.sort((a, b) => b.score - a.score || a.position - b.position);
    return found.slice(0, limit).map(({ id, name, score }) => ({ id, name, score }));
  }
}
