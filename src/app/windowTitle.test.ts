import { describe, expect, it } from 'vitest';

import { windowTitle } from './windowTitle';

describe('windowTitle', () => {
  it('is the app name on a welcome tab', () => {
    expect(windowTitle({ tab: null, connection: null })).toBe('yadbe');
  });

  it('puts the tab and its connection first', () => {
    expect(windowTitle({ tab: 'Query 2', connection: 'pg-eu' })).toBe('Query 2 · pg-eu — yadbe');
    expect(windowTitle({ tab: 'Query 2', connection: null })).toBe('Query 2 — yadbe');
  });
});
