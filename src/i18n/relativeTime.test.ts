import { describe, expect, it } from 'vitest';

import { formatDuration, formatRelativeTime } from './relativeTime';

const NOW = 1_791_795_600_000;

describe('formatRelativeTime', () => {
  it('uses the largest fitting unit', () => {
    expect(formatRelativeTime(NOW / 1000 - 120, NOW, 'en')).toBe('2 minutes ago');
    expect(formatRelativeTime(NOW / 1000 - 3 * 86_400, NOW, 'fr')).toBe('il y a 3 jours');
    expect(formatRelativeTime(NOW / 1000 - 3_600, NOW, 'en')).toBe('1 hour ago');
  });

  it('reads "now" under a minute', () => {
    expect(formatRelativeTime(NOW / 1000 - 10, NOW, 'en')).toBe('now');
    expect(formatRelativeTime(NOW / 1000, NOW, 'fr')).toBe('maintenant');
  });
});

describe('formatDuration', () => {
  it('formats milliseconds and seconds per locale', () => {
    expect(formatDuration(412, 'en')).toBe('412 ms');
    expect(formatDuration(1284, 'en')).toBe('1.3 s');
    expect(formatDuration(1284, 'fr')).toBe('1,3 s');
  });
});
