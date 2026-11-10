import type { ValueKind } from '../../ipc';
import { isNumericKind, JSON_NUMBER, jsonOfCell } from './cellJson';

/**
 * Text formats of a copied selection (F-063). Pure functions: the cells come in as their
 * lossless text (`null` for SQL `NULL`) with their kind, and nothing is converted through a
 * JavaScript number, so 64-bit integers and decimals stay exact.
 */

export type CopyFormat = 'tsv' | 'csv' | 'json' | 'markdown' | 'insert' | 'inList';

export const COPY_FORMATS: readonly CopyFormat[] = [
  'tsv',
  'csv',
  'json',
  'markdown',
  'insert',
  'inList',
];

export interface CopyColumn {
  name: string;
  kind: ValueKind;
}

export interface CopyCell {
  text: string | null;
  kind: ValueKind;
}

export interface CopyTable {
  columns: readonly CopyColumn[];
  rows: readonly (readonly CopyCell[])[];
}

export interface CopyOptions {
  /** Column names first (TSV, CSV, Markdown), objects instead of arrays (JSON), a column list (INSERT). */
  headers: boolean;
  /** Target of `INSERT INTO` (the grid does not know which table a result comes from). */
  tableName?: string;
  /** Identifier quoting of the connection's dialect; ANSI double quotes by default. */
  quoteIdentifier?: (name: string) => string;
}

export const DEFAULT_TABLE_NAME = 'table_name';

export function formatCopy(format: CopyFormat, table: CopyTable, options: CopyOptions): string {
  switch (format) {
    case 'tsv':
      return formatTsv(table, options);
    case 'csv':
      return formatCsv(table, options);
    case 'json':
      return formatJson(table, options);
    case 'markdown':
      return formatMarkdown(table);
    case 'insert':
      return formatInsert(table, options);
    case 'inList':
      return formatInList(table);
  }
}

function lines(table: CopyTable, headers: boolean, cell: (text: string | null) => string): string {
  const out: string[] = [];
  if (headers) out.push(table.columns.map((c) => cell(c.name)).join('\t'));
  for (const row of table.rows) out.push(row.map((c) => cell(c.text)).join('\t'));
  return out.join('\n');
}

/**
 * Tab-separated, the way spreadsheets paste it: `NULL` and the empty string both become an
 * empty cell; a value with a tab, a line break or a leading quote is quoted (`"` doubled).
 */
export function formatTsv(table: CopyTable, options: Pick<CopyOptions, 'headers'>): string {
  return lines(table, options.headers, (text) => {
    if (text === null) return '';
    return /[\t\n\r]|^"/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  });
}

/**
 * RFC 4180 with `\n` line ends. `NULL` is an empty field and the empty string a quoted `""`, so
 * the two stay distinct; fields with a comma, a quote, a line break or edge spaces are quoted.
 */
export function formatCsv(table: CopyTable, options: Pick<CopyOptions, 'headers'>): string {
  const field = (text: string | null): string => {
    if (text === null) return '';
    if (text === '' || /[",\n\r]|^\s|\s$/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };
  const out: string[] = [];
  if (options.headers) out.push(table.columns.map((c) => field(c.name)).join(','));
  for (const row of table.rows) out.push(row.map((c) => field(c.text)).join(','));
  return out.join('\n');
}

/** Names unique within a row object: a second `id` becomes `id_2`. */
function uniqueNames(columns: readonly CopyColumn[]): string[] {
  const seen = new Map<string, number>();
  return columns.map(({ name }) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count === 1) return name;
    let candidate = `${name}_${String(count)}`;
    while (seen.has(candidate)) candidate += '_';
    seen.set(candidate, 1);
    return candidate;
  });
}

/** An array with one row per line: objects keyed by column name, or arrays without headers. */
export function formatJson(table: CopyTable, options: Pick<CopyOptions, 'headers'>): string {
  if (table.rows.length === 0) return '[]';
  const keys = uniqueNames(table.columns).map((name) => JSON.stringify(name));
  const rows = table.rows.map((row) =>
    options.headers
      ? `{${row.map((cell, i) => `${keys[i] ?? '""'}: ${jsonOfCell(cell.text, cell.kind)}`).join(', ')}}`
      : `[${row.map((cell) => jsonOfCell(cell.text, cell.kind)).join(', ')}]`,
  );
  return `[\n  ${rows.join(',\n  ')}\n]`;
}

function markdownCell(text: string | null): string {
  if (text === null) return 'NULL';
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n|\r/g, '<br>');
}

/** A GitHub-flavored table (always with its header row, which the format requires). */
export function formatMarkdown(table: CopyTable): string {
  const header = `| ${table.columns.map((c) => markdownCell(c.name)).join(' | ')} |`;
  const rule = `| ${table.columns.map((c) => (isNumericKind(c.kind) ? '---:' : '---')).join(' | ')} |`;
  const rows = table.rows.map((row) => `| ${row.map((c) => markdownCell(c.text)).join(' | ')} |`);
  return [header, rule, ...rows].join('\n');
}

/** ANSI quoting, skipped for plain lowercase names. */
export function quoteIdentifierAnsi(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) && !SQL_RESERVED.has(name)
    ? name
    : `"${name.replace(/"/g, '""')}"`;
}

const SQL_RESERVED = new Set([
  'all',
  'and',
  'as',
  'by',
  'case',
  'check',
  'column',
  'constraint',
  'create',
  'default',
  'delete',
  'desc',
  'distinct',
  'end',
  'from',
  'group',
  'having',
  'in',
  'index',
  'insert',
  'into',
  'is',
  'join',
  'key',
  'limit',
  'not',
  'null',
  'on',
  'or',
  'order',
  'primary',
  'references',
  'select',
  'table',
  'to',
  'union',
  'unique',
  'update',
  'user',
  'values',
  'where',
]);

/**
 * A SQL literal for a cell. Copied text is meant to be read and edited, not run by yadbe, so it
 * is written out (this is not SQL yadbe executes: rule 2 binds the values of what it runs).
 */
export function sqlLiteral(cell: CopyCell): string {
  const { text, kind } = cell;
  if (text === null) return 'NULL';
  if (isNumericKind(kind) && JSON_NUMBER.test(text)) return text;
  if (kind === 'bool' && (text === 'true' || text === 'false')) return text.toUpperCase();
  if (kind === 'bytes' && /^[0-9a-fA-F]*$/.test(text)) return `X'${text}'`;
  return `'${text.replace(/'/g, "''")}'`;
}

/** One `INSERT` per row; the column list when `headers` is set. */
export function formatInsert(table: CopyTable, options: CopyOptions): string {
  const quote = options.quoteIdentifier ?? quoteIdentifierAnsi;
  const target = options.tableName ?? DEFAULT_TABLE_NAME;
  const columns = options.headers ? ` (${table.columns.map((c) => quote(c.name)).join(', ')})` : '';
  return table.rows
    .map((row) => `INSERT INTO ${target}${columns} VALUES (${row.map(sqlLiteral).join(', ')});`)
    .join('\n');
}

/** `(a, b, c)` of the selected values, row by row, without duplicates. */
export function formatInList(table: CopyTable): string {
  const seen = new Set<string>();
  for (const row of table.rows) for (const cell of row) seen.add(sqlLiteral(cell));
  return `(${[...seen].join(', ')})`;
}
