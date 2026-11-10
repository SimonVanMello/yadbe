import { describe, expect, it } from 'vitest';

import { fuzzyMatch } from './fuzzy';

const rank = (query: string, texts: string[]) =>
  texts
    .map((text) => ({ text, match: fuzzyMatch(query, text) }))
    .filter((entry) => entry.match !== null)
    .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
    .map((entry) => entry.text);

describe('fuzzyMatch', () => {
  it('matches subsequences case-insensitively', () => {
    expect(fuzzyMatch('PGE', 'pg-eu')?.indices).toEqual([0, 1, 3]);
    expect(fuzzyMatch('pgu', 'pg-eu')).not.toBeNull();
    expect(fuzzyMatch('xyz', 'pg-eu')).toBeNull();
  });

  it('accepts an empty query', () => {
    expect(fuzzyMatch('  ', 'pg-eu')).toEqual({ score: 0, indices: [] });
  });

  it('prefers prefixes and word boundaries', () => {
    expect(rank('la', ['legacy-api', 'linux', 'lab'])).toEqual(['lab', 'legacy-api']);
    expect(rank('api', ['rapid', 'legacy-api'])[0]).toBe('legacy-api');
  });

  it('prefers consecutive characters and shorter names', () => {
    expect(rank('pg', ['p-g-x', 'pg-eu'])[0]).toBe('pg-eu');
    expect(rank('pg', ['pg-eu-replica', 'pg-eu'])).toEqual(['pg-eu', 'pg-eu-replica']);
  });

  it('highlights the boundary occurrence, also after an @', () => {
    expect(fuzzyMatch('a', 'legacy-api')?.indices).toEqual([7]);
    expect(fuzzyMatch('s', 'users@shop')?.indices).toEqual([6]);
  });
});
