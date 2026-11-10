import { describe, expect, it } from 'vitest';

import { guardApplies, guardLines, oneLine } from './dangerGuard';
import { findDangerousStatements } from './dangerousStatements';

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

describe('guardLines', () => {
  const text = 'select 1;\ndelete from t;\nselect 2;';
  const ranges = [
    { from: 0, to: 8 },
    { from: 10, to: 23 },
    { from: 25, to: 33 },
  ];

  it('lists each statement once and marks the dangerous one in a short script', () => {
    const lines = guardLines(text, ranges, findDangerousStatements(text, ranges));
    expect(lines.map((line) => [line.number, line.sql, line.kind])).toEqual([
      [1, 'select 1', null],
      [2, 'delete from t', 'deleteWithoutWhere'],
      [3, 'select 2', null],
    ]);
  });

  it('lists only the dangerous statements of a long script', () => {
    const many = Array.from({ length: 10 }, (_, i) => `select ${String(i)};`);
    const longText = [...many.slice(0, 4), 'drop table t;', ...many.slice(4)].join('\n');
    let at = 0;
    const longRanges = longText.split('\n').map((line) => {
      const range = { from: at, to: at + line.length - 1 };
      at += line.length + 1;
      return range;
    });
    const lines = guardLines(longText, longRanges, findDangerousStatements(longText, longRanges));
    expect(lines).toEqual([{ number: 5, sql: 'drop table t', kind: 'drop' }]);
  });
});
