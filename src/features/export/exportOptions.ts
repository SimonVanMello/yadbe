import type {
  BinaryEncoding,
  CsvDelimiter,
  CsvOptions,
  CsvQuote,
  ExportFormat,
  ExportScope,
  JsonLayout,
  JsonNumbers,
  JsonOptions,
  LineEnding,
} from '../../ipc';

export type ExportFormatKind = ExportFormat['format'];

/** What the export dialog remembers between uses. */
export interface ExportPrefs {
  format: ExportFormatKind;
  csv: CsvOptions;
  json: JsonOptions;
}

export const DEFAULT_CSV_OPTIONS: CsvOptions = {
  delimiter: 'comma',
  quote: 'minimal',
  header: true,
  nullText: '',
  lineEnding: 'lf',
  bom: false,
  binary: 'hex',
};

export const DEFAULT_JSON_OPTIONS: JsonOptions = {
  layout: 'array',
  numbers: 'auto',
  binary: 'hex',
};

export const DEFAULT_EXPORT_PREFS: ExportPrefs = {
  format: 'csv',
  csv: DEFAULT_CSV_OPTIONS,
  json: DEFAULT_JSON_OPTIONS,
};

export const CSV_DELIMITERS: readonly CsvDelimiter[] = ['comma', 'semicolon', 'tab'];
export const CSV_QUOTES: readonly CsvQuote[] = ['minimal', 'all', 'nonNumeric'];
export const LINE_ENDINGS: readonly LineEnding[] = ['lf', 'crlf'];
export const BINARY_ENCODINGS: readonly BinaryEncoding[] = ['hex', 'base64'];
export const JSON_LAYOUTS: readonly JsonLayout[] = ['array', 'ndjson'];
export const JSON_NUMBERS: readonly JsonNumbers[] = ['auto', 'strings'];

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Reads the saved slice; tolerant to old, partial or corrupted data. */
export function parseExportPrefs(value: unknown): ExportPrefs {
  const saved = record(value);
  const csv = record(saved.csv);
  const json = record(saved.json);
  const defaults = DEFAULT_CSV_OPTIONS;
  return {
    format: pick(saved.format, ['csv', 'json'], 'csv'),
    csv: {
      delimiter: pick(csv.delimiter, CSV_DELIMITERS, defaults.delimiter),
      quote: pick(csv.quote, CSV_QUOTES, defaults.quote),
      header: flag(csv.header, defaults.header),
      nullText: typeof csv.nullText === 'string' ? csv.nullText.slice(0, 32) : defaults.nullText,
      lineEnding: pick(csv.lineEnding, LINE_ENDINGS, defaults.lineEnding),
      bom: flag(csv.bom, defaults.bom),
      binary: pick(csv.binary, BINARY_ENCODINGS, defaults.binary),
    },
    json: {
      layout: pick(json.layout, JSON_LAYOUTS, DEFAULT_JSON_OPTIONS.layout),
      numbers: pick(json.numbers, JSON_NUMBERS, DEFAULT_JSON_OPTIONS.numbers),
      binary: pick(json.binary, BINARY_ENCODINGS, DEFAULT_JSON_OPTIONS.binary),
    },
  };
}

export function toExportFormat(prefs: ExportPrefs): ExportFormat {
  return prefs.format === 'csv'
    ? { format: 'csv', options: prefs.csv }
    : { format: 'json', options: prefs.json };
}

/** The extension a file of this format gets by default. */
export function defaultExtension(format: ExportFormat): string {
  if (format.format === 'json') return format.options.layout === 'ndjson' ? 'ndjson' : 'json';
  return format.options.delimiter === 'tab' ? 'tsv' : 'csv';
}

/** Extensions the save dialog offers (the backend accepts these and `txt`). */
export function dialogExtensions(format: ExportFormat): string[] {
  return format.format === 'csv' ? ['csv', 'tsv', 'txt'] : ['json', 'ndjson', 'jsonl', 'txt'];
}

/** `result-1` → `result-1.csv`: a file name safe on every OS. */
export function defaultFileName(base: string, format: ExportFormat): string {
  const safe = base.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'result';
  return `${safe}.${defaultExtension(format)}`;
}

/** A name typed in the dialog without an extension gets the format's default. */
export function withExtension(path: string, format: ExportFormat): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return /\.[^./\\]+$/.test(name) ? path : `${path}.${defaultExtension(format)}`;
}

/** The selection of a grid as an export range: loaded rows and data columns, in display order. */
export interface ExportGridRange {
  rowFrom: number;
  rowTo: number;
  columns: number[];
}

export function exportScope(range: ExportGridRange | null, selectionOnly: boolean): ExportScope {
  return range && selectionOnly ? { kind: 'range', ...range } : { kind: 'all' };
}

export function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${units[unit] ?? 'B'}`;
}
