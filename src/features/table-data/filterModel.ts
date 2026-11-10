import type { MessageKey, MessageParams } from '../../i18n/i18n';
import type { FilterOp, TableColumn, TableFilter, Value } from '../../ipc';
import { parseInput } from './cellValues';

/**
 * The filter bar of a table tab (F-081): per-column conditions, as the user typed them, turned
 * into the `TableFilter` the backend binds. Values stay text until then, so a chip can be
 * edited back exactly as it was written.
 */
export interface FilterChip {
  column: string;
  op: FilterOp;
  /** As typed: none for `isNull` / `isNotNull`, two for `between`, one or more for `in`. */
  values: string[];
}

export interface FilterState {
  chips: FilterChip[];
  /** The raw `WHERE` condition; empty: none. */
  rawWhere: string;
}

export const EMPTY_FILTER: FilterState = { chips: [], rawWhere: '' };

const ORDERED: FilterOp[] = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'between', 'in'];
const TEXTUAL: FilterOp[] = ['eq', 'ne', 'contains', 'startsWith', 'endsWith', 'in'];
const NULLS: FilterOp[] = ['isNull', 'isNotNull'];

/** The operators that make sense for a column, most useful first. */
export function operatorsFor(
  column: Pick<TableColumn, 'kind' | 'enumValues' | 'nullable'>,
): FilterOp[] {
  const nulls = column.nullable ? NULLS : [];
  if (column.enumValues) return ['eq', 'ne', 'in', ...nulls];
  switch (column.kind) {
    case 'int':
    case 'decimal':
    case 'float':
    case 'date':
    case 'time':
    case 'timestamp':
    case 'timestampTz':
    case 'interval':
      return [...ORDERED, ...nulls];
    case 'bool':
      return ['eq', ...nulls];
    case 'uuid':
      return ['eq', 'ne', 'in', 'startsWith', ...nulls];
    case 'json':
    case 'array':
      return ['contains', ...nulls];
    case 'bytes':
      return ['eq', 'ne', ...nulls];
    case 'text':
    case 'other':
      return [...TEXTUAL, 'lt', 'gt', ...nulls];
  }
}

/** How many values an operator takes: `[min, max]`. */
export function arity(op: FilterOp): [number, number] {
  switch (op) {
    case 'isNull':
    case 'isNotNull':
      return [0, 0];
    case 'between':
      return [2, 2];
    case 'in':
      return [1, Infinity];
    default:
      return [1, 1];
  }
}

/** Operators compared as text whatever the column type (`LIKE` on the text form). */
function textual(op: FilterOp): boolean {
  return op === 'contains' || op === 'startsWith' || op === 'endsWith';
}

export type ChipValues =
  | { ok: true; values: Value[] }
  | { ok: false; index: number; error: MessageKey; params?: MessageParams };

/** The values of a chip, typed like the column (so SQLite compares numbers as numbers). */
export function chipValues(chip: FilterChip, column: TableColumn): ChipValues {
  const [min, max] = arity(chip.op);
  const texts = chip.values.slice(0, max === Infinity ? undefined : max);
  if (texts.length < min)
    return { ok: false, index: texts.length, error: 'tableData.filter.missingValue' };
  const values: Value[] = [];
  for (const [index, text] of texts.entries()) {
    if (textual(chip.op)) {
      values.push({ kind: 'text', value: text });
      continue;
    }
    const parsed = parseInput(text, column);
    if (!parsed.ok) return { ok: false, index, error: parsed.error, params: parsed.params };
    values.push(parsed.value);
  }
  return { ok: true, values };
}

/** The filter the backend binds; chips whose column is gone or whose values are invalid are left out. */
export function toTableFilter(state: FilterState, columns: readonly TableColumn[]): TableFilter {
  const conditions = state.chips.flatMap((chip) => {
    const column = columns.find((c) => c.name === chip.column);
    if (!column) return [];
    const parsed = chipValues(chip, column);
    return parsed.ok ? [{ column: chip.column, op: chip.op, values: parsed.values }] : [];
  });
  const raw = state.rawWhere.trim();
  return { conditions, rawWhere: raw === '' ? null : raw };
}

export function isFiltered(state: FilterState): boolean {
  return state.chips.length > 0 || state.rawWhere.trim() !== '';
}

/** Operator symbols, the same in every language (labels go through i18n). */
export const OP_SYMBOLS: Record<FilterOp, string> = {
  eq: '=',
  ne: '≠',
  lt: '<',
  le: '≤',
  gt: '>',
  ge: '≥',
  contains: '∋',
  startsWith: 'a…',
  endsWith: '…z',
  in: 'in',
  isNull: 'is null',
  isNotNull: 'is not null',
  between: 'between',
};

/** A chip as one line (`status = paid`, `total between 10 and 20`, `note is null`). */
export function describeChip(
  chip: FilterChip,
  words: { and: string; opLabel: (op: FilterOp) => string },
): string {
  const op = words.opLabel(chip.op);
  switch (chip.op) {
    case 'isNull':
    case 'isNotNull':
      return `${chip.column} ${op}`;
    case 'between':
      return `${chip.column} ${op} ${chip.values[0] ?? ''} ${words.and} ${chip.values[1] ?? ''}`;
    case 'in':
      return `${chip.column} ${op} (${chip.values.join(', ')})`;
    default:
      return `${chip.column} ${op} ${chip.values[0] ?? ''}`;
  }
}

/** Splits the text of an `in` list: one value per line, or comma-separated on one line. */
export function splitList(text: string): string[] {
  const parts = text.includes('\n') ? text.split(/\r?\n/) : text.split(',');
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** Reads a saved filter back; tolerant to partial or foreign data. */
export function parseFilterState(value: unknown): FilterState {
  if (typeof value !== 'object' || value === null) return EMPTY_FILTER;
  const raw = 'rawWhere' in value && typeof value.rawWhere === 'string' ? value.rawWhere : '';
  const list = 'chips' in value && Array.isArray(value.chips) ? (value.chips as unknown[]) : [];
  const chips = list.flatMap((item): FilterChip[] => {
    if (typeof item !== 'object' || item === null) return [];
    const column = 'column' in item ? item.column : undefined;
    const op = 'op' in item ? item.op : undefined;
    const values = 'values' in item && Array.isArray(item.values) ? item.values : [];
    if (typeof column !== 'string' || typeof op !== 'string' || !(op in OP_SYMBOLS)) return [];
    return [
      {
        column,
        op: op as FilterOp,
        values: values.filter((v): v is string => typeof v === 'string'),
      },
    ];
  });
  return { chips, rawWhere: raw };
}
