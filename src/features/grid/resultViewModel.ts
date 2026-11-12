import type { ResultViewSpec, ValueKind, ViewFilter, ViewFilterOp } from '../../ipc';

/**
 * What the user asked of a result's rows (F-065): sort keys and conditions as they typed them.
 * `toSpec` turns it into what the backend applies to the rows it keeps; the user's statement
 * is never run again.
 */
export interface ResultSortKey {
  /** Data column. */
  dataCol: number;
  direction: 'asc' | 'desc';
}

export interface ResultCondition {
  /** Identity of the line in the bar (columns and operators change under it). */
  id: number;
  /** Data column, `null`: every column. */
  column: number | null;
  op: ViewFilterOp;
  value: string;
}

export interface ResultViewState {
  sort: readonly ResultSortKey[];
  conditions: readonly ResultCondition[];
  matchCase: boolean;
  /** The filter bar is shown. */
  barOpen: boolean;
}

export const EMPTY_VIEW: ResultViewState = {
  sort: [],
  conditions: [],
  matchCase: false,
  barOpen: false,
};

/** The operators of the bar, in the order a list shows them. */
export const FILTER_OPS: readonly ViewFilterOp[] = [
  'contains',
  'equals',
  'startsWith',
  'endsWith',
  'greater',
  'greaterOrEqual',
  'less',
  'lessOrEqual',
  'notContains',
  'notEquals',
  'isNull',
  'isNotNull',
];

export const OP_SYMBOLS: Record<ViewFilterOp, string> = {
  contains: '∋',
  notContains: '∌',
  startsWith: 'a…',
  endsWith: '…z',
  equals: '=',
  notEquals: '≠',
  greater: '>',
  greaterOrEqual: '≥',
  less: '<',
  lessOrEqual: '≤',
  isNull: 'is null',
  isNotNull: 'is not null',
};

export function needsValue(op: ViewFilterOp): boolean {
  return op !== 'isNull' && op !== 'isNotNull';
}

/** Operators that mean nothing on every column at once: they need a column. */
export function needsColumn(op: ViewFilterOp): boolean {
  return op === 'greater' || op === 'greaterOrEqual' || op === 'less' || op === 'lessOrEqual';
}

/** Operators that fit a column of this kind (any column: the text ones). */
export function operatorsFor(kind: ValueKind | null): readonly ViewFilterOp[] {
  if (kind === null) return FILTER_OPS.filter((op) => !needsColumn(op));
  switch (kind) {
    case 'int':
    case 'decimal':
    case 'float':
    case 'date':
    case 'time':
    case 'timestamp':
    case 'timestampTz':
    case 'interval':
      return FILTER_OPS.filter((op) => op !== 'startsWith' && op !== 'endsWith');
    case 'bool':
      return ['equals', 'notEquals', 'isNull', 'isNotNull'];
    default:
      return FILTER_OPS;
  }
}

/** The next sort after a header click: ascending, descending, none; `additive`: one more key. */
export function nextSort(
  current: readonly ResultSortKey[],
  dataCol: number,
  additive: boolean,
): ResultSortKey[] {
  const index = current.findIndex((key) => key.dataCol === dataCol);
  const existing = current[index];
  if (additive) {
    if (!existing) return [...current, { dataCol, direction: 'asc' }];
    if (existing.direction === 'asc') {
      return current.map((key, i) => (i === index ? { ...key, direction: 'desc' } : key));
    }
    return current.filter((_, i) => i !== index);
  }
  if (existing && current.length === 1) {
    return existing.direction === 'asc' ? [{ dataCol, direction: 'desc' }] : [];
  }
  return [{ dataCol, direction: 'asc' }];
}

/** A condition that can be sent: it has the value its operator needs and a column if it needs one. */
export function isComplete(condition: ResultCondition): boolean {
  if (needsColumn(condition.op) && condition.column === null) return false;
  return !needsValue(condition.op) || condition.value !== '';
}

/** The spec the backend applies, `null` when the view changes nothing. */
export function toSpec(state: ResultViewState, columnCount: number): ResultViewSpec | null {
  const sort = state.sort
    .filter((key) => key.dataCol < columnCount)
    .map((key) => ({ column: key.dataCol, descending: key.direction === 'desc' }));
  const filters: ViewFilter[] = state.conditions
    .filter((condition) => isComplete(condition) && (condition.column ?? 0) < columnCount)
    .map((condition) => ({
      column: condition.column,
      op: condition.op,
      value: needsValue(condition.op) ? condition.value : '',
    }));
  if (sort.length === 0 && filters.length === 0) return null;
  return { sort, filters, matchCase: state.matchCase };
}

/** Conditions that are in force (complete ones). */
export function activeFilterCount(state: ResultViewState): number {
  return state.conditions.filter(isComplete).length;
}
