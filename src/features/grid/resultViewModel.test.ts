import { beforeEach, describe, expect, it } from 'vitest';

import {
  EMPTY_VIEW,
  activeFilterCount,
  isComplete,
  nextSort,
  operatorsFor,
  toSpec,
  type ResultCondition,
  type ResultSortKey,
} from './resultViewModel';
import { useResultViewStore } from './resultViewStore';

const asc = (dataCol: number): ResultSortKey => ({ dataCol, direction: 'asc' });
const desc = (dataCol: number): ResultSortKey => ({ dataCol, direction: 'desc' });
const condition = (change: Partial<ResultCondition>): ResultCondition => ({
  id: 1,
  column: null,
  op: 'contains',
  value: '',
  ...change,
});

describe('nextSort', () => {
  it('cycles ascending, descending, none on one column', () => {
    expect(nextSort([], 2, false)).toEqual([asc(2)]);
    expect(nextSort([asc(2)], 2, false)).toEqual([desc(2)]);
    expect(nextSort([desc(2)], 2, false)).toEqual([]);
  });

  it('replaces the keys by the clicked column, unless Shift adds it', () => {
    expect(nextSort([asc(1), desc(3)], 2, false)).toEqual([asc(2)]);
    expect(nextSort([asc(1)], 2, true)).toEqual([asc(1), asc(2)]);
    expect(nextSort([asc(1), asc(2)], 2, true)).toEqual([asc(1), desc(2)]);
    expect(nextSort([asc(1), desc(2)], 2, true)).toEqual([asc(1)]);
  });
});

describe('toSpec', () => {
  it('sends nothing when nothing is in force', () => {
    expect(toSpec(EMPTY_VIEW, 5)).toBeNull();
    // A condition that is not finished (no value yet) filters nothing.
    expect(toSpec({ ...EMPTY_VIEW, conditions: [condition({ value: '' })] }, 5)).toBeNull();
  });

  it('sends the sort keys and the finished conditions', () => {
    const spec = toSpec(
      {
        ...EMPTY_VIEW,
        sort: [asc(1), desc(0)],
        conditions: [
          condition({ column: 2, op: 'greater', value: '10' }),
          condition({ id: 2, column: 3, op: 'isNull', value: 'stale' }),
          condition({ id: 3, op: 'contains', value: '' }),
        ],
        matchCase: true,
      },
      5,
    );
    expect(spec).toEqual({
      sort: [
        { column: 1, descending: false },
        { column: 0, descending: true },
      ],
      filters: [
        { column: 2, op: 'greater', value: '10' },
        { column: 3, op: 'isNull', value: '' },
      ],
      matchCase: true,
    });
  });

  it('leaves out what names a column the result does not have', () => {
    const spec = toSpec(
      { ...EMPTY_VIEW, sort: [asc(9)], conditions: [condition({ column: 7, value: 'x' })] },
      3,
    );
    expect(spec).toBeNull();
  });

  it('counts the conditions in force', () => {
    expect(
      activeFilterCount({
        ...EMPTY_VIEW,
        conditions: [condition({ value: 'x' }), condition({ id: 2, value: '' })],
      }),
    ).toBe(1);
    // An ordering needs a column to compare.
    expect(isComplete(condition({ op: 'greater', value: '1', column: null }))).toBe(false);
  });
});

describe('operatorsFor', () => {
  it('offers the ordering operators on a column, not on every column at once', () => {
    expect(operatorsFor(null)).not.toContain('greater');
    expect(operatorsFor('int')).toContain('greater');
    expect(operatorsFor('int')).not.toContain('startsWith');
    expect(operatorsFor('bool')).toEqual(['equals', 'notEquals', 'isNull', 'isNotNull']);
    expect(operatorsFor('text')).toContain('startsWith');
  });
});

describe('the result view store', () => {
  beforeEach(() => {
    useResultViewStore.setState({ views: {} });
  });

  const kindOf = (column: number | null) => (column === 1 ? ('int' as const) : null);

  it('keeps one view per result', () => {
    const store = useResultViewStore.getState();
    store.sortBy(1, 0, false);
    store.sortBy(2, 3, false);
    expect(useResultViewStore.getState().views[1]?.sort).toEqual([asc(0)]);
    expect(useResultViewStore.getState().views[2]?.sort).toEqual([asc(3)]);
  });

  it('adds, edits and removes conditions, and fixes an operator the column does not take', () => {
    const store = useResultViewStore.getState();
    store.addCondition(1, null);
    const [first] = useResultViewStore.getState().views[1]?.conditions ?? [];
    expect(first).toMatchObject({ column: null, op: 'contains', value: '' });
    expect(useResultViewStore.getState().views[1]?.barOpen).toBe(true);
    store.updateCondition(1, first?.id ?? 0, { column: 1, op: 'startsWith' }, kindOf);
    // `startsWith` means nothing on an integer column: the first operator that fits.
    expect(useResultViewStore.getState().views[1]?.conditions[0]?.op).toBe('contains');
    store.updateCondition(1, first?.id ?? 0, { op: 'greater', value: '5' }, kindOf);
    expect(useResultViewStore.getState().views[1]?.conditions[0]).toMatchObject({
      column: 1,
      op: 'greater',
      value: '5',
    });
    // Back to every column: `greater` no longer fits.
    store.updateCondition(1, first?.id ?? 0, { column: null }, kindOf);
    expect(useResultViewStore.getState().views[1]?.conditions[0]?.op).toBe('contains');
    store.removeCondition(1, first?.id ?? 0);
    expect(useResultViewStore.getState().views[1]?.conditions).toEqual([]);
  });

  it('clears the sort and the conditions but leaves the bar as it is', () => {
    const store = useResultViewStore.getState();
    store.sortBy(1, 0, false);
    store.addCondition(1, null);
    store.clear(1);
    expect(useResultViewStore.getState().views[1]).toMatchObject({
      sort: [],
      conditions: [],
      barOpen: true,
    });
  });
});
