import type {
  BinaryEncoding,
  CsvDelimiter,
  CsvOptions,
  CsvQuote,
  Engine,
  ExportFormat,
  ExportScope,
  ExtendedJsonMode,
  JsonLayout,
  JsonLinesOptions,
  JsonNumbers,
  JsonOptions,
  LineEnding,
  MarkdownOptions,
} from '../../ipc';

export type ExportFormatKind = ExportFormat['format'];

/** SQL inserts (F-066); the table is asked each time, it is not a preference. */
export interface SqlPrefs {
  /** The engine whose quoting and literals the script uses; `null`: the source connection's. */
  engine: Engine | null;
  rowsPerStatement: number;
  lineEnding: LineEnding;
}

/** JSON Lines: grid rows as objects, or whole documents when the source has them. */
export interface JsonLinesPrefs {
  numbers: JsonNumbers;
  binary: BinaryEncoding;
  /** MongoDB documents: every BSON type wrapped, or plain numbers and dates. */
  extendedJson: ExtendedJsonMode;
  /** Search hits: the hit's `_id` and `_index` written before its `_source`. */
  includeId: boolean;
  includeIndex: boolean;
}

export interface ExcelPrefs {
  binary: BinaryEncoding;
}

/** What the export dialog remembers between uses. */
export interface ExportPrefs {
  format: ExportFormatKind;
  csv: CsvOptions;
  json: JsonOptions;
  jsonLines: JsonLinesPrefs;
  sql: SqlPrefs;
  markdown: MarkdownOptions;
  excel: ExcelPrefs;
}

/** What the dialog knows of the source, which the formats that name things need. */
export interface FormatContext {
  /** The source connection's engine: what a script is written for unless asked otherwise. */
  engine: Engine;
  /** Target of the `INSERT` statements. */
  schema: string;
  table: string;
  sheetName: string;
  /**
   * The source also has its whole documents (a MongoDB or search result): the result id that
   * holds them, and what they are. JSON Lines writes these instead of the grid rows.
   */
  documents?: { resultId: number; kind: 'mongo' | 'search' } | null;
}

export const DEFAULT_FORMAT_CONTEXT: FormatContext = {
  engine: 'postgres',
  schema: '',
  table: 'table_name',
  sheetName: 'Result',
};

export const MAX_ROWS_PER_STATEMENT = 500;

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

export const DEFAULT_JSON_LINES_PREFS: JsonLinesPrefs = {
  numbers: 'auto',
  binary: 'hex',
  extendedJson: 'canonical',
  includeId: false,
  includeIndex: false,
};

export const DEFAULT_SQL_PREFS: SqlPrefs = { engine: null, rowsPerStatement: 50, lineEnding: 'lf' };

export const DEFAULT_MARKDOWN_OPTIONS: MarkdownOptions = {
  nullText: 'NULL',
  alignNumbers: true,
  binary: 'hex',
  lineEnding: 'lf',
};

export const DEFAULT_EXCEL_PREFS: ExcelPrefs = { binary: 'hex' };

export const DEFAULT_EXPORT_PREFS: ExportPrefs = {
  format: 'csv',
  csv: DEFAULT_CSV_OPTIONS,
  json: DEFAULT_JSON_OPTIONS,
  jsonLines: DEFAULT_JSON_LINES_PREFS,
  sql: DEFAULT_SQL_PREFS,
  markdown: DEFAULT_MARKDOWN_OPTIONS,
  excel: DEFAULT_EXCEL_PREFS,
};

export const EXPORT_FORMATS: readonly ExportFormatKind[] = [
  'csv',
  'json',
  'jsonLines',
  'sql',
  'markdown',
  'excel',
];
/** The engines a saved SQL export may name (engines of the SQL family: they have a dialect). */
const SQL_ENGINES: readonly Engine[] = ['postgres', 'mssql', 'mysql', 'sqlite'];

export const CSV_DELIMITERS: readonly CsvDelimiter[] = ['comma', 'semicolon', 'tab'];
export const CSV_QUOTES: readonly CsvQuote[] = ['minimal', 'all', 'nonNumeric'];
export const LINE_ENDINGS: readonly LineEnding[] = ['lf', 'crlf'];
export const BINARY_ENCODINGS: readonly BinaryEncoding[] = ['hex', 'base64'];
export const JSON_LAYOUTS: readonly JsonLayout[] = ['array', 'ndjson'];
export const JSON_NUMBERS: readonly JsonNumbers[] = ['auto', 'strings'];
export const EXTENDED_JSON_MODES: readonly ExtendedJsonMode[] = ['canonical', 'relaxed'];

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
  const jsonLines = record(saved.jsonLines);
  const sql = record(saved.sql);
  const markdown = record(saved.markdown);
  const excel = record(saved.excel);
  const defaults = DEFAULT_CSV_OPTIONS;
  return {
    format: pick(saved.format, EXPORT_FORMATS, 'csv'),
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
    jsonLines: {
      numbers: pick(jsonLines.numbers, JSON_NUMBERS, DEFAULT_JSON_LINES_PREFS.numbers),
      binary: pick(jsonLines.binary, BINARY_ENCODINGS, DEFAULT_JSON_LINES_PREFS.binary),
      extendedJson: pick(
        jsonLines.extendedJson,
        EXTENDED_JSON_MODES,
        DEFAULT_JSON_LINES_PREFS.extendedJson,
      ),
      includeId: flag(jsonLines.includeId, DEFAULT_JSON_LINES_PREFS.includeId),
      includeIndex: flag(jsonLines.includeIndex, DEFAULT_JSON_LINES_PREFS.includeIndex),
    },
    sql: {
      engine: SQL_ENGINES.find((engine) => engine === sql.engine) ?? null,
      rowsPerStatement: clampRows(sql.rowsPerStatement),
      lineEnding: pick(sql.lineEnding, LINE_ENDINGS, DEFAULT_SQL_PREFS.lineEnding),
    },
    markdown: {
      nullText:
        typeof markdown.nullText === 'string'
          ? markdown.nullText.slice(0, 32)
          : DEFAULT_MARKDOWN_OPTIONS.nullText,
      alignNumbers: flag(markdown.alignNumbers, DEFAULT_MARKDOWN_OPTIONS.alignNumbers),
      binary: pick(markdown.binary, BINARY_ENCODINGS, DEFAULT_MARKDOWN_OPTIONS.binary),
      lineEnding: pick(markdown.lineEnding, LINE_ENDINGS, DEFAULT_MARKDOWN_OPTIONS.lineEnding),
    },
    excel: { binary: pick(excel.binary, BINARY_ENCODINGS, DEFAULT_EXCEL_PREFS.binary) },
  };
}

/** Rows per `INSERT`: a whole number from 1 to 500. */
export function clampRows(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_ROWS_PER_STATEMENT, Math.max(1, Math.round(value)))
    : DEFAULT_SQL_PREFS.rowsPerStatement;
}

export function toExportFormat(
  prefs: ExportPrefs,
  context: FormatContext = DEFAULT_FORMAT_CONTEXT,
): ExportFormat {
  switch (prefs.format) {
    case 'csv':
      return { format: 'csv', options: prefs.csv };
    case 'json':
      return { format: 'json', options: prefs.json };
    case 'jsonLines': {
      const { numbers, binary, extendedJson, includeId, includeIndex } = prefs.jsonLines;
      const kind = context.documents?.kind;
      const options: JsonLinesOptions = {
        numbers,
        binary,
        documents:
          kind === 'mongo'
            ? { kind: 'mongo', extendedJson }
            : kind === 'search'
              ? { kind: 'search', includeId, includeIndex }
              : null,
      };
      return { format: 'jsonLines', options };
    }
    case 'sql':
      return {
        format: 'sql',
        options: {
          engine: prefs.sql.engine ?? context.engine,
          schema: context.schema,
          table: context.table,
          rowsPerStatement: prefs.sql.rowsPerStatement,
          lineEnding: prefs.sql.lineEnding,
        },
      };
    case 'markdown':
      return { format: 'markdown', options: prefs.markdown };
    case 'excel':
      return {
        format: 'excel',
        options: { sheetName: context.sheetName, binary: prefs.excel.binary },
      };
  }
}

/** The extension a file of this format gets by default. */
export function defaultExtension(format: ExportFormat): string {
  switch (format.format) {
    case 'json':
      return format.options.layout === 'ndjson' ? 'ndjson' : 'json';
    case 'jsonLines':
      return 'jsonl';
    case 'csv':
      return format.options.delimiter === 'tab' ? 'tsv' : 'csv';
    case 'sql':
      return 'sql';
    case 'markdown':
      return 'md';
    case 'excel':
      return 'xlsx';
  }
}

/** Extensions the save dialog offers (the backend accepts these, and `txt` but for Excel). */
export function dialogExtensions(format: ExportFormat): string[] {
  switch (format.format) {
    case 'csv':
      return ['csv', 'tsv', 'txt'];
    case 'json':
      return ['json', 'ndjson', 'jsonl', 'txt'];
    case 'jsonLines':
      return ['jsonl', 'ndjson', 'txt'];
    case 'sql':
      return ['sql', 'txt'];
    case 'markdown':
      return ['md', 'markdown', 'txt'];
    case 'excel':
      return ['xlsx'];
  }
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
