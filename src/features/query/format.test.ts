import { describe, expect, it } from 'vitest';

import { formatDuration } from './format';

describe('formatDuration', () => {
  it.each([
    [0, '< 1 ms'],
    [0.4, '< 1 ms'],
    [38, '38 ms'],
    [999.4, '999 ms'],
    [1200, '1.2 s'],
    [59_000, '59.0 s'],
    [60_000, '1 min 00 s'],
    [123_000, '2 min 03 s'],
    [-5, '0 ms'],
    [Number.NaN, '0 ms'],
  ])('formats %s as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
