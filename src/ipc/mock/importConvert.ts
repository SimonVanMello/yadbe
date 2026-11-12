import type { ImportConvertOptions, ImportIssueKind, ImportTargetColumn } from '../bindings';

/** `(precision, scale)` of `numeric(10,2)`. */
function decimalSpec(typeName: string): [number, number] | null {
  const match = /^(?:numeric|decimal|dec|number)\((\d+)(?:\s*,\s*(\d+))?\)/i.exec(typeName.trim());
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : null;
}

function maxChars(typeName: string): number | null {
  const match = /char[a-z ]*\((\d+)\)/i.exec(typeName);
  return match ? Number(match[1]) : null;
}

function validDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year > 0 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function validClock(text: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?$/.test(text);
}

/**
 * What the backend's converter (`import/convert.rs`) says of `cell` for `column`, `null` when
 * it converts. Same rules, written compactly for the mock.
 */
export function checkCell(
  column: ImportTargetColumn,
  cell: string | null,
  options: ImportConvertOptions,
): ImportIssueKind | null {
  if (cell === null) return column.nullable ? null : 'nullNotAllowed';
  const text = column.kind === 'text' ? cell : cell.trim();
  const typeName = column.typeName.toLowerCase();
  switch (column.kind) {
    case 'text': {
      const max = maxChars(typeName);
      return max !== null && Array.from(text).length > max ? 'tooLong' : null;
    }
    case 'bool':
      return /^(true|t|yes|y|1|on|false|f|no|n|0|off)$/i.test(text) ? null : 'invalidFormat';
    case 'int': {
      if (!/^[+-]?\d+$/.test(text)) return 'invalidFormat';
      const value = BigInt(text);
      const small = /smallint|int2/.test(typeName);
      const limit = small ? 32_767n : 9_223_372_036_854_775_807n;
      return value > limit || value < -limit - 1n ? 'outOfRange' : null;
    }
    case 'decimal':
    case 'float': {
      const comma = options.decimalSeparator === 'comma';
      if (comma ? text.includes('.') : text.includes(',')) return 'invalidFormat';
      const normalized = comma ? text.replace(',', '.') : text;
      if (column.kind === 'float' && /^[+-]?(nan|inf|infinity)$/i.test(normalized)) return null;
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(normalized)) return 'invalidFormat';
      const spec = column.kind === 'decimal' ? decimalSpec(typeName) : null;
      if (spec && !/[eE]/.test(normalized)) {
        const body = normalized.replace(/^[+-]/, '');
        const [whole = '', fraction = ''] = body.split('.');
        if (fraction.replace(/0+$/, '').length > spec[1]) return 'tooManyDecimals';
        if (whole.replace(/^0+/, '').length + spec[1] > spec[0]) return 'outOfRange';
      }
      return null;
    }
    case 'bytes':
      return (options.binary === 'hex'
        ? /^(0x|\\x)?([0-9a-f]{2})*$/i
        : /^[A-Za-z0-9+/_-]*={0,2}$/
      ).test(text)
        ? null
        : 'invalidFormat';
    case 'date':
      return validDate(text) ? null : 'invalidFormat';
    case 'time':
      return validClock(text) ? null : 'invalidFormat';
    case 'timestamp':
    case 'timestampTz': {
      const match =
        /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?)?$/.exec(
          text,
        );
      if (!match || !validDate(match[1] ?? '')) return 'invalidFormat';
      if (match[2] !== undefined && !validClock(match[2])) return 'invalidFormat';
      if (match[3] !== undefined && column.kind === 'timestamp') return 'unexpectedTimeZone';
      return null;
    }
    case 'uuid':
      return /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i.test(text)
        ? null
        : 'invalidFormat';
    case 'json':
      try {
        JSON.parse(text);
        return null;
      } catch {
        return 'invalidFormat';
      }
    default:
      return null;
  }
}
