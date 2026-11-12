import type { MessageKey, MessageParams } from '../../i18n/i18n';
import type { TableColumn, Value, ValueKind } from '../../ipc';
import { valueText } from '../grid/rowSource';

/**
 * Cell values of a table tab (F-082): from the lossless text of a window back to a `Value`, and
 * from what the user typed to the `Value` sent to the backend. Never through a JavaScript number,
 * so 64-bit integers and decimals stay exact (rule 8).
 */

/** The value of a cell as a window holds it (its text, `null` for NULL, and its kind). */
export function cellValue(text: string | null, kind: ValueKind): Value {
  if (text === null) return { kind: 'null' };
  switch (kind) {
    case 'bool':
      return { kind, value: text === 'true' };
    case 'array': {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) return { kind, value: parsed as Value[] };
      } catch {
        // Not the JSON of values: kept as text below.
      }
      return { kind: 'other', value: text };
    }
    case 'missing':
      return { kind: 'missing' };
    default:
      return { kind, value: text };
  }
}

export function valuesEqual(a: Value, b: Value): boolean {
  return a.kind === b.kind && valueText(a) === valueText(b);
}

/** What a column needs for parsing a typed value. */
export type EditColumn = Pick<TableColumn, 'kind' | 'typeName' | 'enumValues' | 'nullable'>;

export type ParseResult =
  { ok: true; value: Value } | { ok: false; error: MessageKey; params?: MessageParams };

function fail(error: MessageKey, params?: MessageParams): ParseResult {
  return params ? { ok: false, error, params } : { ok: false, error };
}

/** Kinds the grid cannot write back from text (arrays need their element type). */
export function isEditableKind(kind: ValueKind): boolean {
  return kind !== 'array';
}

const INT_RANGES: Record<string, [bigint, bigint]> = {
  smallint: [-32768n, 32767n],
  int2: [-32768n, 32767n],
  tinyint: [0n, 255n],
  integer: [-2147483648n, 2147483647n],
  int: [-2147483648n, 2147483647n],
  int4: [-2147483648n, 2147483647n],
  mediumint: [-8388608n, 8388607n],
  bigint: [-9223372036854775808n, 9223372036854775807n],
  int8: [-9223372036854775808n, 9223372036854775807n],
};

function baseType(typeName: string): string {
  return typeName
    .toLowerCase()
    .replace(/\(.*\)/, '')
    .replace(/\bunsigned\b/, '')
    .trim();
}

function parseInteger(text: string, typeName: string): ParseResult {
  const match = /^([+-]?)0*(\d+)$/.exec(text);
  if (!match) return fail('tableData.invalid.int');
  const digits = match[2] ?? '0';
  const value = match[1] === '-' && digits !== '0' ? `-${digits}` : digits;
  const range = INT_RANGES[baseType(typeName)];
  if (range) {
    const n = BigInt(value);
    if (n < range[0] || n > range[1]) {
      return fail('tableData.invalid.range', {
        min: range[0].toString(),
        max: range[1].toString(),
      });
    }
  }
  return { ok: true, value: { kind: 'int', value } };
}

const SPECIAL_NUMBERS = /^(nan|[+-]?infinity|[+-]?inf)$/i;

function normalizeSpecial(text: string): string {
  const lower = text.toLowerCase().replace(/^\+/, '');
  if (lower === 'nan') return 'NaN';
  return lower.startsWith('-') ? '-Infinity' : 'Infinity';
}

function parseDecimal(text: string, typeName: string): ParseResult {
  if (SPECIAL_NUMBERS.test(text))
    return { ok: true, value: { kind: 'decimal', value: normalizeSpecial(text) } };
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  const whole = match?.[2] ?? '';
  const fraction = match?.[3] ?? '';
  if (!match || (whole === '' && fraction === '')) return fail('tableData.invalid.decimal');
  // numeric(p, s): the integer part must fit in p - s digits (the engine rounds the fraction).
  const scale = /\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/.exec(typeName);
  if (scale && match[4] === undefined) {
    const precision = Number(scale[1]);
    const digits = precision - Number(scale[2] ?? 0);
    const integer = whole.replace(/^0+/, '');
    if (integer.length > digits) return fail('tableData.invalid.precision', { digits });
  }
  return { ok: true, value: { kind: 'decimal', value: text.replace(/^\+/, '') } };
}

function parseFloating(text: string): ParseResult {
  if (SPECIAL_NUMBERS.test(text))
    return { ok: true, value: { kind: 'float', value: normalizeSpecial(text) } };
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return fail('tableData.invalid.float');
  return { ok: true, value: { kind: 'float', value: text.replace(/^\+/, '') } };
}

export function parseBool(text: string): boolean | null {
  const lower = text.trim().toLowerCase();
  if (['true', 't', '1', 'yes', 'y', 'on'].includes(lower)) return true;
  if (['false', 'f', '0', 'no', 'n', 'off'].includes(lower)) return false;
  return null;
}

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;
  return day <= days;
}

const DATE = /^(\d{4,})-(\d{1,2})-(\d{1,2})( BC)?$/i;
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?$/;
const OFFSET = /^(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

function normalizeDate(text: string): string | null {
  if (/^-?infinity$/i.test(text)) return text.toLowerCase();
  const match = DATE.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!validDate(year, month, day)) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${match[1] ?? ''}-${pad(month)}-${pad(day)}${match[4] ? ' BC' : ''}`;
}

/** `HH:MM[:SS[.f]]` → `HH:MM:SS[.f]`, `null` when invalid. */
function normalizeTime(text: string): string | null {
  const match = TIME.exec(text);
  if (!match) return null;
  const [hours, minutes, seconds] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  const whole = hours === 24 && minutes === 0 && seconds === 0 && !match[4];
  if ((hours > 23 && !whole) || minutes > 59 || seconds > 60) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${match[4] ?? ''}`;
}

/** Splits `10:00:00+02:00` into the time and its offset (`+02:00`, `Z` → `+00`). */
function splitOffset(text: string): { time: string; offset: string | null } {
  const match = /^(.*?)(Z|[+-]\d{2}(?::?\d{2})?)$/i.exec(text);
  if (!match || !OFFSET.test(match[2] ?? '')) return { time: text, offset: null };
  const offset = (match[2] ?? '').toUpperCase() === 'Z' ? '+00' : (match[2] ?? '');
  return { time: (match[1] ?? '').trim(), offset };
}

function withTimeZone(typeName: string): boolean {
  const type = typeName.toLowerCase();
  return type.includes('with time zone') || type === 'timetz' || type === 'timestamptz';
}

function parseTime(text: string, typeName: string): ParseResult {
  const { time, offset } = splitOffset(text);
  const normalized = normalizeTime(time);
  if (!normalized) return fail('tableData.invalid.time');
  if (offset && !withTimeZone(typeName)) return fail('tableData.invalid.time');
  return { ok: true, value: { kind: 'time', value: `${normalized}${offset ?? ''}` } };
}

function parseTimestamp(text: string, kind: 'timestamp' | 'timestampTz'): ParseResult {
  if (/^-?infinity$/i.test(text)) return { ok: true, value: { kind, value: text.toLowerCase() } };
  const match = /^(\S+?)(?:[ T](.+))?$/.exec(text);
  const date = normalizeDate(match?.[1] ?? '');
  if (!match || !date)
    return fail(
      kind === 'timestamp' ? 'tableData.invalid.timestamp' : 'tableData.invalid.timestampTz',
    );
  const rest = match[2] ?? '00:00:00';
  const { time, offset } = splitOffset(rest);
  const normalized = normalizeTime(time);
  if (!normalized || (offset && kind === 'timestamp')) {
    return fail(
      kind === 'timestamp' ? 'tableData.invalid.timestamp' : 'tableData.invalid.timestampTz',
    );
  }
  return { ok: true, value: { kind, value: `${date} ${normalized}${offset ?? ''}` } };
}

/**
 * The value of what the user typed in a cell of `column`, or why it is not one. The engine has
 * the last word (it converts the text with the column's type); this catches the obvious
 * mistakes before anything is sent, and keeps every digit typed.
 */
export function parseInput(input: string, column: EditColumn): ParseResult {
  const { kind } = column;
  const text = kind === 'text' || kind === 'json' || kind === 'other' ? input : input.trim();
  if (column.enumValues) {
    return column.enumValues.includes(text)
      ? { ok: true, value: { kind: kind === 'other' ? 'other' : 'text', value: text } }
      : fail('tableData.invalid.enum', { values: column.enumValues.join(', ') });
  }
  switch (kind) {
    case 'int':
      return parseInteger(text, column.typeName);
    case 'decimal':
      return parseDecimal(text, column.typeName);
    case 'float':
      return parseFloating(text);
    case 'bool': {
      const value = parseBool(text);
      return value === null ? fail('tableData.invalid.bool') : { ok: true, value: { kind, value } };
    }
    case 'date': {
      const value = normalizeDate(text);
      return value ? { ok: true, value: { kind, value } } : fail('tableData.invalid.date');
    }
    case 'time':
      return parseTime(text, column.typeName);
    case 'timestamp':
    case 'timestampTz':
      return parseTimestamp(text, kind);
    case 'interval':
      return text ? { ok: true, value: { kind, value: text } } : fail('tableData.invalid.interval');
    case 'uuid': {
      const hex = text
        .replace(/^\{|\}$/g, '')
        .replace(/-/g, '')
        .toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(hex)) return fail('tableData.invalid.uuid');
      const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      return { ok: true, value: { kind, value } };
    }
    case 'json':
      try {
        JSON.parse(text);
      } catch {
        return fail('tableData.invalid.json');
      }
      return { ok: true, value: { kind, value: text } };
    case 'bytes': {
      const hex = text
        .replace(/^(\\x|0x)/i, '')
        .replace(/\s+/g, '')
        .toLowerCase();
      return /^([0-9a-f]{2})*$/.test(hex)
        ? { ok: true, value: { kind, value: hex } }
        : fail('tableData.invalid.bytes');
    }
    case 'array':
      return fail('tableData.invalid.array');
    case 'text':
    case 'other':
      return { ok: true, value: { kind, value: text } };
    case 'objectId':
      return /^[0-9a-fA-F]{24}$/.test(text)
        ? { ok: true, value: { kind, value: text.toLowerCase() } }
        : fail('document.invalid.objectId');
    case 'missing':
      return { ok: true, value: { kind: 'text', value: text } };
  }
}

/** The text an editor starts from for a value (`''` for NULL). */
export function editText(value: Value): string {
  return valueText(value) ?? '';
}

/** A short placeholder showing the expected format of a kind, or `null` for free text. */
export function formatHint(kind: ValueKind): string | null {
  switch (kind) {
    case 'date':
      return 'YYYY-MM-DD';
    case 'time':
      return 'HH:MM:SS';
    case 'timestamp':
      return 'YYYY-MM-DD HH:MM:SS';
    case 'timestampTz':
      return 'YYYY-MM-DD HH:MM:SS+00';
    case 'uuid':
      return '00000000-0000-0000-0000-000000000000';
    case 'bytes':
      return '0a1b2c…';
    default:
      return null;
  }
}
