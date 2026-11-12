import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXPORT_PREFS,
  DEFAULT_FORMAT_CONTEXT,
  clampRows,
  defaultFileName,
  dialogExtensions,
  exportScope,
  formatBytes,
  parseExportPrefs,
  toExportFormat,
  withExtension,
} from './exportOptions';

describe('parseExportPrefs', () => {
  it('falls back to the defaults on anything unreadable', () => {
    for (const bad of [undefined, null, 3, 'csv', [], { format: 'xml', csv: 7 }]) {
      expect(parseExportPrefs(bad)).toEqual(DEFAULT_EXPORT_PREFS);
    }
  });

  it('keeps what is valid and drops the rest field by field', () => {
    const prefs = parseExportPrefs({
      format: 'json',
      csv: { delimiter: 'tab', quote: 'bogus', header: false, nullText: 'NULL', bom: true },
      json: { layout: 'ndjson', numbers: 'strings', binary: 'base64' },
    });
    expect(prefs.format).toBe('json');
    expect(prefs.csv).toMatchObject({
      delimiter: 'tab',
      quote: 'minimal',
      header: false,
      nullText: 'NULL',
      bom: true,
      lineEnding: 'lf',
    });
    expect(prefs.json).toEqual({ layout: 'ndjson', numbers: 'strings', binary: 'base64' });
  });

  it('round-trips through JSON', () => {
    const saved = JSON.parse(JSON.stringify(DEFAULT_EXPORT_PREFS)) as unknown;
    expect(parseExportPrefs(saved)).toEqual(DEFAULT_EXPORT_PREFS);
  });
});

describe('the SQL, Markdown and Excel formats', () => {
  const context = {
    engine: 'mssql' as const,
    schema: 'shop',
    table: 'orders',
    sheetName: 'Orders',
  };

  it('builds each format from the dialog, the script for the connection unless asked otherwise', () => {
    const sql = { ...DEFAULT_EXPORT_PREFS, format: 'sql' as const };
    expect(toExportFormat(sql, context)).toEqual({
      format: 'sql',
      options: {
        engine: 'mssql',
        schema: 'shop',
        table: 'orders',
        rowsPerStatement: 50,
        lineEnding: 'lf',
      },
    });
    expect(
      toExportFormat({ ...sql, sql: { ...sql.sql, engine: 'sqlite' } }, context),
    ).toMatchObject({ options: { engine: 'sqlite' } });
    expect(toExportFormat({ ...DEFAULT_EXPORT_PREFS, format: 'markdown' }, context)).toEqual({
      format: 'markdown',
      options: DEFAULT_EXPORT_PREFS.markdown,
    });
    expect(toExportFormat({ ...DEFAULT_EXPORT_PREFS, format: 'excel' }, context)).toEqual({
      format: 'excel',
      options: { sheetName: 'Orders', binary: 'hex' },
    });
  });

  it('proposes their extensions and the types the save dialog offers', () => {
    for (const [format, name, extensions] of [
      ['sql', 'orders.sql', ['sql', 'txt']],
      ['markdown', 'orders.md', ['md', 'markdown', 'txt']],
      ['excel', 'orders.xlsx', ['xlsx']],
    ] as const) {
      const built = toExportFormat({ ...DEFAULT_EXPORT_PREFS, format }, context);
      expect(defaultFileName('orders', built)).toBe(name);
      expect(dialogExtensions(built)).toEqual(extensions);
    }
  });

  it('reads and bounds the saved options', () => {
    const prefs = parseExportPrefs({
      format: 'excel',
      sql: { engine: 'oracle', rowsPerStatement: 100_000, lineEnding: 'crlf' },
      markdown: { nullText: '∅', alignNumbers: false, binary: 'base64', lineEnding: 'bad' },
      excel: { binary: 'base64' },
    });
    expect(prefs.format).toBe('excel');
    expect(prefs.sql).toEqual({ engine: null, rowsPerStatement: 500, lineEnding: 'crlf' });
    expect(prefs.markdown).toEqual({
      nullText: '∅',
      alignNumbers: false,
      binary: 'base64',
      lineEnding: 'lf',
    });
    expect(prefs.excel.binary).toBe('base64');
    expect(clampRows(0)).toBe(1);
    expect(clampRows(Number.NaN)).toBe(50);
  });
});

describe('file names', () => {
  const csv = toExportFormat(DEFAULT_EXPORT_PREFS);
  const tsv = toExportFormat({
    ...DEFAULT_EXPORT_PREFS,
    csv: { ...DEFAULT_EXPORT_PREFS.csv, delimiter: 'tab' },
  });
  const ndjson = toExportFormat({
    ...DEFAULT_EXPORT_PREFS,
    format: 'json',
    json: { ...DEFAULT_EXPORT_PREFS.json, layout: 'ndjson' },
  });

  it('proposes an extension that follows the options', () => {
    expect(defaultFileName('Result 1', csv)).toBe('Result_1.csv');
    expect(defaultFileName('Résultat 2', tsv)).toBe('R_sultat_2.tsv');
    expect(defaultFileName('', ndjson)).toBe('result.ndjson');
  });

  it('adds the extension to a name typed without one', () => {
    expect(withExtension('/home/ana/out', csv)).toBe('/home/ana/out.csv');
    expect(withExtension('/home/ana/out.txt', csv)).toBe('/home/ana/out.txt');
    expect(withExtension('C:\\data.d\\out', ndjson)).toBe('C:\\data.d\\out.ndjson');
  });
});

describe('scope and sizes', () => {
  const range = { rowFrom: 2, rowTo: 9, columns: [3, 1] };

  it('exports the selection only when asked and when there is one', () => {
    expect(exportScope(range, true)).toEqual({ kind: 'range', ...range });
    expect(exportScope(range, false)).toEqual({ kind: 'all' });
    expect(exportScope(null, true)).toEqual({ kind: 'all' });
  });

  it('formats byte counts', () => {
    expect(formatBytes(0, 'en')).toBe('0 B');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(250 * 1024 * 1024, 'en')).toBe('250 MB');
  });

  it('writes JSON Lines as whole documents only when the source has them', () => {
    const prefs = parseExportPrefs({
      format: 'jsonLines',
      jsonLines: { extendedJson: 'relaxed', includeId: true, includeIndex: 'yes' },
    });
    expect(prefs.jsonLines).toMatchObject({
      extendedJson: 'relaxed',
      includeId: true,
      includeIndex: false,
    });
    const rows = toExportFormat(prefs);
    expect(rows).toMatchObject({ format: 'jsonLines', options: { documents: null } });
    const mongo = toExportFormat(prefs, {
      ...DEFAULT_FORMAT_CONTEXT,
      documents: { resultId: 9, kind: 'mongo' },
    });
    expect(mongo).toMatchObject({
      options: { documents: { kind: 'mongo', extendedJson: 'relaxed' } },
    });
    const search = toExportFormat(prefs, {
      ...DEFAULT_FORMAT_CONTEXT,
      documents: { resultId: 9, kind: 'search' },
    });
    expect(search).toMatchObject({
      options: { documents: { kind: 'search', includeId: true, includeIndex: false } },
    });
    expect(defaultFileName('orders', rows)).toBe('orders.jsonl');
    expect(dialogExtensions(rows)).toEqual(['jsonl', 'ndjson', 'txt']);
  });
});
