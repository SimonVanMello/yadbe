import { describe, expect, it } from 'vitest';

import {
  DEFAULT_QUERY_UI,
  DEFAULT_RESULTS_RATIO,
  MAX_RESULTS_RATIO,
  MIN_RESULTS_RATIO,
  clampRatio,
  parseQueryUi,
} from './queryUiStore';

describe('the saved editor settings', () => {
  it('has a default: results at a bit under half', () => {
    expect(DEFAULT_QUERY_UI).toEqual({ resultsRatio: DEFAULT_RESULTS_RATIO });
  });

  it('reads a saved slice and ignores the settings that moved to the preferences', () => {
    expect(parseQueryUi({ resultsRatio: 0.6, confirmDangerous: false })).toEqual({
      resultsRatio: 0.6,
    });
  });

  it.each([undefined, null, 'x', 42, [], { resultsRatio: 'wide' }])(
    'falls back to the defaults for %j',
    (saved) => {
      expect(parseQueryUi(saved)).toEqual(DEFAULT_QUERY_UI);
    },
  );

  it('keeps the split between its bounds', () => {
    expect(clampRatio(0)).toBe(MIN_RESULTS_RATIO);
    expect(clampRatio(5)).toBe(MAX_RESULTS_RATIO);
    expect(clampRatio(Number.NaN)).toBe(DEFAULT_RESULTS_RATIO);
    expect(parseQueryUi({ resultsRatio: 9 }).resultsRatio).toBe(MAX_RESULTS_RATIO);
  });
});
