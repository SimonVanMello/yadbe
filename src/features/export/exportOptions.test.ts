import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXPORT_PREFS,
  defaultFileName,
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
});
