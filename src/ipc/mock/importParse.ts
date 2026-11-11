import type { ImportDelimiter, ImportFormat, ImportParseOptions } from '../bindings';

/** One row of an import file; `null` is `NULL`. */
export interface MockRecord {
  /** 1-based line the row starts on. */
  line: number;
  cells: (string | null)[];
  /** The field count when it differs from the header's. */
  ragged: number | null;
}

export interface MockParsed {
  columns: string[];
  records: MockRecord[];
}

export class MockParseError extends Error {
  constructor(
    readonly line: number,
    readonly problem: string,
  ) {
    super(problem);
  }
}

export const DELIMITERS: Record<ImportDelimiter, string> = {
  comma: ',',
  semicolon: ';',
  tab: '\t',
  pipe: '|',
};

const BOM = String.fromCharCode(0xfeff);

export const DEFAULT_PARSE_OPTIONS: ImportParseOptions = {
  format: 'csv',
  encoding: 'utf8',
  delimiter: 'comma',
  quote: 'double',
  header: true,
  nullToken: null,
  emptyAsNull: true,
  trim: false,
  skipRows: 0,
};

interface RawField {
  text: string;
  quoted: boolean;
}

interface RawRecord {
  line: number;
  fields: RawField[];
}

/** The records of a CSV text (`import/csv.rs`): quotes, doubled quotes, line breaks in fields. */
export function csvRecords(text: string, delimiter: string, quote: string | null): RawRecord[] {
  const records: RawRecord[] = [];
  let line = 1;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const startLine = line;
    const fields: RawField[] = [];
    let current = '';
    let quoted = false;
    let any = false;
    let ended = false;
    while (i < n && !ended) {
      const c = text.charAt(i);
      any = true;
      if (quote !== null && c === quote && current === '' && !quoted) {
        quoted = true;
        i++;
        let closed = false;
        while (i < n) {
          const q = text.charAt(i);
          if (q === quote) {
            if (text.charAt(i + 1) === quote) {
              current += quote;
              i += 2;
              continue;
            }
            i++;
            closed = true;
            break;
          }
          if (q === '\n') line++;
          current += q;
          i++;
        }
        if (!closed) throw new MockParseError(startLine, 'a quoted field is never closed');
      } else if (c === delimiter) {
        fields.push({ text: current, quoted });
        current = '';
        quoted = false;
        i++;
      } else if (c === '\n' || c === '\r') {
        i += c === '\r' && text.charAt(i + 1) === '\n' ? 2 : 1;
        line++;
        ended = true;
      } else {
        current += c;
        i++;
      }
    }
    if (!any) break;
    fields.push({ text: current, quoted });
    const blank = fields.length === 1 && fields[0]?.text === '' && !fields[0].quoted;
    if (!blank) records.push({ line: startLine, fields });
  }
  return records;
}

function cellOf(field: RawField, options: ImportParseOptions): string | null {
  if (field.quoted) return field.text;
  const text = options.trim ? field.text.trim() : field.text;
  const isNull =
    (options.emptyAsNull && text === '') ||
    (options.nullToken !== null && options.nullToken === text);
  return isNull ? null : text;
}

function jsonRecords(text: string, format: ImportFormat): MockParsed {
  const trimmed = text.trim();
  let objects: unknown[] = [];
  const lines: number[] = [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      objects = Array.isArray(parsed) ? parsed : [];
    } catch {
      throw new MockParseError(1, 'the file is not valid JSON');
    }
    objects.forEach((_, index) => lines.push(index + 2));
  } else if (format === 'json') {
    throw new MockParseError(1, 'the file is not a JSON array of objects');
  } else {
    text.split('\n').forEach((row, index) => {
      if (row.trim() === '') return;
      try {
        objects.push(JSON.parse(row));
        lines.push(index + 1);
      } catch {
        throw new MockParseError(index + 1, 'a line is not valid JSON');
      }
    });
  }
  const columns: string[] = [];
  for (const object of objects.slice(0, 1000)) {
    if (typeof object !== 'object' || object === null || Array.isArray(object)) {
      throw new MockParseError(1, 'an element is not a JSON object');
    }
    for (const key of Object.keys(object)) if (!columns.includes(key)) columns.push(key);
  }
  const records = objects.map((object, index): MockRecord => {
    const entries = object as Record<string, unknown>;
    return {
      line: lines[index] ?? index + 1,
      ragged: null,
      cells: columns.map((column) => {
        const value = entries[column];
        if (value === undefined || value === null) return null;
        if (typeof value === 'string') return value;
        return typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);
      }),
    };
  });
  return { columns, records };
}

/** The columns and rows of a file's text under `options` (`import/parse.rs`). */
export function readFile(text: string, options: ImportParseOptions): MockParsed {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  if (options.format !== 'csv') return jsonRecords(body, options.format);
  const lines = body.split(/\r\n|\r|\n/);
  const skipped = lines.slice(options.skipRows).join('\n');
  const records = csvRecords(
    options.skipRows > 0 ? skipped : body,
    DELIMITERS[options.delimiter],
    options.quote === 'double' ? '"' : options.quote === 'single' ? "'" : null,
  );
  const first = records[0];
  if (!first) return { columns: [], records: [] };
  const columns = options.header
    ? first.fields.map((f, i) => f.text.trim() || `Column ${i + 1}`)
    : first.fields.map((_, i) => `Column ${i + 1}`);
  const rows = options.header ? records.slice(1) : records;
  return {
    columns,
    records: rows.map((record) => ({
      line: record.line + options.skipRows,
      cells: record.fields.map((f) => cellOf(f, options)),
      ragged: record.fields.length === columns.length ? null : record.fields.length,
    })),
  };
}

/** The options a file seems to need (`parse::detect`). */
export function detectOptions(
  text: string,
  path: string,
): { options: ImportParseOptions; bom: boolean } {
  const bom = text.startsWith(BOM);
  const body = bom ? text.slice(1) : text;
  const options = { ...DEFAULT_PARSE_OPTIONS };
  const first = body.trimStart().charAt(0);
  if (first === '[') return { options: { ...options, format: 'json' }, bom };
  if (first === '{' || /\.(jsonl|ndjson)$/i.test(path)) {
    return { options: { ...options, format: 'jsonLines' }, bom };
  }
  let best: { delimiter: ImportDelimiter; rows: number; fields: number } | null = null;
  for (const delimiter of ['comma', 'semicolon', 'tab', 'pipe'] as const) {
    const sample = csvRecordsSafe(body.slice(0, 64 * 1024), DELIMITERS[delimiter]).slice(0, 30);
    const counts = new Map<number, number>();
    for (const record of sample) counts.set(record.length, (counts.get(record.length) ?? 0) + 1);
    let rows = 0;
    let fields = 0;
    for (const [count, seen] of counts) {
      if (seen > rows || (seen === rows && count > fields)) {
        rows = seen;
        fields = count;
      }
    }
    if (fields < 2) continue;
    if (!best || rows > best.rows || (rows === best.rows && fields > best.fields)) {
      best = { delimiter, rows, fields };
    }
  }
  options.delimiter = best?.delimiter ?? 'comma';
  const sample = csvRecordsSafe(body.slice(0, 64 * 1024), DELIMITERS[options.delimiter]);
  const head = sample[0];
  if (head) {
    const names = head.map((n) => n.trim());
    options.header =
      new Set(names).size === names.length &&
      names.every((n) => n !== '' && Number.isNaN(Number(n)));
  }
  const cells = sample.flat();
  options.nullToken = cells.includes('\\N') ? '\\N' : cells.includes('NULL') ? 'NULL' : null;
  return { options, bom };
}

function csvRecordsSafe(text: string, delimiter: string): string[][] {
  try {
    return csvRecords(text, delimiter, '"').map((r) => r.fields.map((f) => f.text));
  } catch {
    return [];
  }
}
