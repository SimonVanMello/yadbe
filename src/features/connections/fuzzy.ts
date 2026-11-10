export interface FuzzyMatch {
  score: number;
  /** Indices of the matched characters in the text, for highlighting. */
  indices: number[];
}

const BOUNDARY = /[\s/\\_.@:-]/;

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1] ?? '';
  const current = text[index] ?? '';
  return (
    BOUNDARY.test(previous) ||
    (previous === previous.toLowerCase() && current !== current.toLowerCase())
  );
}

/**
 * Case-insensitive subsequence match. Consecutive characters and characters at word
 * boundaries score higher, gaps cost a little, so `pge` ranks `pg-eu` above `shop-staging-core`.
 * Returns `null` when the query is not a subsequence of the text.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const needle = query.trim().toLowerCase();
  if (needle === '') return { score: 0, indices: [] };
  const haystack = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of needle) {
    if (char === ' ') continue;
    // Prefer an occurrence at a word boundary when one exists before the next fallback.
    let index = haystack.indexOf(char, from);
    if (index === -1) return null;
    let boundary = index;
    while (boundary !== -1 && !isBoundary(text, boundary) && boundary !== previous + 1) {
      boundary = haystack.indexOf(char, boundary + 1);
    }
    if (boundary !== -1 && boundary !== index && !(index === previous + 1)) index = boundary;
    if (index === previous + 1) score += 8;
    else if (previous >= 0) score -= Math.min(index - previous - 1, 6);
    if (isBoundary(text, index)) score += 6;
    if (index === 0) score += 4;
    score += 1;
    indices.push(index);
    previous = index;
    from = index + 1;
  }
  // Shorter texts win ties: "pg-eu" before "pg-eu-replica".
  score -= text.length * 0.01;
  return { score, indices };
}
