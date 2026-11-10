import { describe, expect, it } from 'vitest';

import { guardApplies, oneLine } from './dangerGuard';

describe('guardApplies', () => {
  it('follows the preference on an ordinary connection', () => {
    expect(guardApplies({ environment: null, readOnly: false }, true)).toBe(true);
    expect(guardApplies({ environment: 'dev', readOnly: false }, false)).toBe(false);
  });

  it('is always on for a prod-tagged connection', () => {
    expect(guardApplies({ environment: 'prod', readOnly: false }, false)).toBe(true);
  });

  it('leaves a read-only connection to the backend, which refuses the statement', () => {
    expect(guardApplies({ environment: 'prod', readOnly: true }, true)).toBe(false);
  });
});

describe('oneLine', () => {
  it('flattens whitespace and shortens', () => {
    expect(oneLine('delete\n  from orders\n')).toBe('delete from orders');
    expect(oneLine('x'.repeat(300), 10)).toBe('xxxxxxxxx…');
  });
});
