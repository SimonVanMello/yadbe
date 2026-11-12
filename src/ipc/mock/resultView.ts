import type { ResultViewSpec, ValueKind, ViewFilter } from '../bindings';
import { compareDecimal, parseDecimal, type AggregateCell, type Decimal } from './resultAggregate';

/**
 * The mock of the backend's sort and filter of a stored result (F-065): same rules as
 * `result_view.rs` (numbers by value, text without regard to case, NULL last in both
 * directions), built again from scratch when asked.
 */

type Key =
  | { rank: 3 }
  | { rank: 0; decimal: Decimal }
  | { rank: 0; float: number }
  | { rank: 1; bool: boolean }
  | { rank: 2; text: string };

function keyOf(cell: AggregateCell): Key {
  if (!cell) return { rank: 3 };
  const [kind, text] = cell;
  if (kind === 'int' || kind === 'decimal') {
    const decimal = parseDecimal(text);
    return decimal ? { rank: 0, decimal } : { rank: 2, text };
  }
  if (kind === 'float') {
    const float = Number(text);
    return text.trim() !== '' && Number.isFinite(float) ? { rank: 0, float } : { rank: 2, text };
  }
  if (kind === 'bool') return { rank: 1, bool: text === 'true' };
  return { rank: 2, text };
}

function asFloat(key: Key & { rank: 0 }): number {
  return 'float' in key ? key.float : Number(key.decimal.digits) / 10 ** key.decimal.scale;
}

function compareNumbers(a: Key & { rank: 0 }, b: Key & { rank: 0 }): number {
  if ('decimal' in a && 'decimal' in b) return compareDecimal(a.decimal, b.decimal);
  return Math.sign(asFloat(a) - asFloat(b));
}

function compareFolded(a: string, b: string, matchCase: boolean): number {
  const [left, right] = matchCase ? [a, b] : [a.toLowerCase(), b.toLowerCase()];
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareKeys(a: Key, b: Key, matchCase: boolean): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.rank === 0 && b.rank === 0) return compareNumbers(a, b);
  if (a.rank === 1 && b.rank === 1) return Number(a.bool) - Number(b.bool);
  if (a.rank === 2 && b.rank === 2) {
    return compareFolded(a.text, b.text, matchCase) || compareFolded(a.text, b.text, true);
  }
  return 0;
}

function numeric(kind: ValueKind): boolean {
  return kind === 'int' || kind === 'decimal' || kind === 'float';
}

/** A cell against the condition's value: by number when both are numbers, else as text. */
function order(kind: ValueKind, text: string, value: string, matchCase: boolean): number {
  if (numeric(kind)) {
    const cell = keyOf([kind, text]);
    const wanted = parseDecimal(value);
    if (cell.rank === 0 && wanted) return compareNumbers(cell, { rank: 0, decimal: wanted });
  }
  return compareFolded(text, value, matchCase);
}

function positive(filter: ViewFilter, kind: ValueKind, text: string, matchCase: boolean): boolean {
  const [hay, needle] = matchCase
    ? [text, filter.value]
    : [text.toLowerCase(), filter.value.toLowerCase()];
  switch (filter.op) {
    case 'contains':
    case 'notContains':
      return hay.includes(needle);
    case 'startsWith':
      return hay.startsWith(needle);
    case 'endsWith':
      return hay.endsWith(needle);
    case 'equals':
    case 'notEquals':
      return order(kind, text, filter.value, matchCase) === 0;
    case 'greater':
      return order(kind, text, filter.value, matchCase) > 0;
    case 'greaterOrEqual':
      return order(kind, text, filter.value, matchCase) >= 0;
    case 'less':
      return order(kind, text, filter.value, matchCase) < 0;
    case 'lessOrEqual':
      return order(kind, text, filter.value, matchCase) <= 0;
    default:
      return true;
  }
}

function cellMatches(filter: ViewFilter, cell: AggregateCell, matchCase: boolean): boolean {
  const negated = filter.op === 'notContains' || filter.op === 'notEquals';
  if (filter.op === 'isNull') return cell === null;
  if (filter.op === 'isNotNull') return cell !== null;
  if (!cell) return negated;
  return positive(filter, cell[0], cell[1], matchCase) !== negated;
}

function rowPasses(
  filter: ViewFilter,
  row: number,
  width: number,
  cellAt: (row: number, column: number) => AggregateCell,
  matchCase: boolean,
): boolean {
  if (filter.column !== null) return cellMatches(filter, cellAt(row, filter.column), matchCase);
  const columns = Array.from({ length: width }, (_, column) => cellAt(row, column));
  switch (filter.op) {
    case 'isNotNull':
      return columns.every((cell) => cell !== null);
    case 'isNull':
      return columns.some((cell) => cell === null);
    case 'notContains':
    case 'notEquals':
      return !columns.some(
        (cell) => cell !== null && positive(filter, cell[0], cell[1], matchCase),
      );
    default:
      return columns.some((cell) => cell !== null && positive(filter, cell[0], cell[1], matchCase));
  }
}

/** The stored rows that pass `spec`, in the order it asks for. */
export function viewRows(
  spec: ResultViewSpec,
  rowCount: number,
  width: number,
  cellAt: (row: number, column: number) => AggregateCell,
): number[] {
  const rows: number[] = [];
  for (let row = 0; row < rowCount; row++) {
    if (
      spec.filters.every((filter) => rowPasses(filter, row, width, cellAt, spec.matchCase === true))
    ) {
      rows.push(row);
    }
  }
  if (spec.sort.length === 0) return rows;
  const keys = spec.sort.map(
    (sort) => new Map(rows.map((row) => [row, keyOf(cellAt(row, sort.column))])),
  );
  return rows.sort((a, b) => {
    for (const [index, sort] of spec.sort.entries()) {
      const left = keys[index]?.get(a);
      const right = keys[index]?.get(b);
      if (!left || !right) continue;
      if (left.rank === 3 || right.rank === 3) {
        if (left.rank === right.rank) continue;
        return left.rank === 3 ? 1 : -1;
      }
      const found = compareKeys(left, right, spec.matchCase === true);
      if (found !== 0) return sort.descending ? -found : found;
    }
    return a - b;
  });
}
