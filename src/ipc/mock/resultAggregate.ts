import type { AggregateRange, SelectionAggregate, ValueKind } from '../bindings';

/** A cell as the mock stores it: its kind and lossless text, `null` for SQL `NULL`. */
export type AggregateCell = readonly [ValueKind, string] | null;

interface Decimal {
  negative: boolean;
  /** Digits of the integer and fractional parts together. */
  digits: bigint;
  scale: number;
}

const PLAIN = /^([+-]?)(\d*)(?:\.(\d*))?$/;

function parseDecimal(text: string): Decimal | null {
  const match = PLAIN.exec(text.trim());
  if (!match) return null;
  const int = match[2] ?? '';
  const frac = (match[3] ?? '').replace(/0+$/, '');
  if (int === '' && (match[3] ?? '') === '') return null;
  const digits = BigInt(`${int}${frac}` || '0');
  return { negative: match[1] === '-' && digits !== 0n, digits, scale: frac.length };
}

function compare(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const left = BigInt(a.negative ? -1 : 1) * a.digits * 10n ** BigInt(scale - a.scale);
  const right = BigInt(b.negative ? -1 : 1) * b.digits * 10n ** BigInt(scale - b.scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `value` (scaled by `scale`) as a plain decimal, no trailing zeros. */
function format(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, '');
  return `${negative && (int !== '0' || frac !== '') ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** The mock of the backend's `aggregate_result_selection`: same rules, same figures. */
export function aggregateSelection(
  ranges: readonly AggregateRange[],
  rowCount: number,
  columnCount: number,
  cellAt: (row: number, column: number) => AggregateCell,
): SelectionAggregate {
  const perColumn: [number, number][][] = Array.from({ length: columnCount }, () => []);
  for (const range of ranges) {
    const end = Math.min(range.rowEnd, rowCount);
    if (range.rowStart >= end) continue;
    for (const column of range.columns) perColumn[column]?.push([range.rowStart, end]);
  }
  let cells = 0;
  let nonNull = 0;
  let exact = 0;
  let floats = 0;
  let sum = 0n;
  let scale = 0;
  let min: Decimal | null = null;
  let max: Decimal | null = null;
  let floatSum = 0;
  let floatMin: number | null = null;
  let floatMax: number | null = null;

  perColumn.forEach((spans, column) => {
    spans.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const span of spans) {
      const last = merged.at(-1);
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else merged.push([span[0], span[1]]);
    }
    for (const [start, end] of merged) {
      for (let row = start; row < end; row++) {
        cells++;
        const cell = cellAt(row, column);
        if (!cell) continue;
        nonNull++;
        const [kind, text] = cell;
        if (kind === 'int' || kind === 'decimal') {
          const number = parseDecimal(text);
          if (!number) continue;
          exact++;
          if (number.scale > scale) {
            sum *= 10n ** BigInt(number.scale - scale);
            scale = number.scale;
          }
          sum +=
            BigInt(number.negative ? -1 : 1) * number.digits * 10n ** BigInt(scale - number.scale);
          if (!min || compare(number, min) < 0) min = number;
          if (!max || compare(number, max) > 0) max = number;
        } else if (kind === 'float') {
          const value = Number(text);
          if (text.trim() === '' || !Number.isFinite(value)) continue;
          floats++;
          floatSum += value;
          floatMin = floatMin === null ? value : Math.min(floatMin, value);
          floatMax = floatMax === null ? value : Math.max(floatMax, value);
        }
      }
    }
  });

  const numeric = exact + floats;
  const result: SelectionAggregate = {
    cells,
    nonNull,
    numeric,
    sum: null,
    avg: null,
    min: null,
    max: null,
    exact: floats === 0,
  };
  if (nonNull === 0 || numeric !== nonNull) return result;
  const text = (d: Decimal | null) =>
    d ? format(BigInt(d.negative ? -1 : 1) * d.digits, d.scale) : null;
  if (floats === 0) {
    result.sum = format(sum, scale);
    // Six more digits than the sum, rounded half away from zero.
    const extra = 6;
    const scaled = (sum < 0n ? -sum : sum) * 10n ** BigInt(extra);
    const count = BigInt(exact);
    let quotient = scaled / count;
    if ((scaled % count) * 2n >= count) quotient += 1n;
    result.avg = format(sum < 0n ? -quotient : quotient, scale + extra);
    result.min = text(min);
    result.max = text(max);
    return result;
  }
  const exactTotal = Number(format(sum, scale));
  const total = floatSum + exactTotal;
  const extreme = (
    float: number | null,
    d: Decimal | null,
    pick: (a: number, b: number) => number,
  ) =>
    [float, d ? Number(text(d)) : null]
      .filter((n): n is number => n !== null)
      .reduce((a, b) => pick(a, b));
  result.sum = String(total);
  result.avg = String(total / numeric);
  result.min = String(extreme(floatMin, min, Math.min));
  result.max = String(extreme(floatMax, max, Math.max));
  return result;
}
