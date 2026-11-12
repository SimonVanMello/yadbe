import { describe, expect, it } from 'vitest';

import type {
  ColumnMeta,
  ExportFinished,
  ExportFormat,
  ExportSourceSpec,
  Value,
} from '../bindings';
import { EventEmitter } from '../emitter';
import { mockErrors } from '../mockErrors';
import { createMockExport } from './export';

const columns: ColumnMeta[] = [
  { name: 'id', typeName: 'int8', kind: 'int' },
  { name: 'name', typeName: 'text', kind: 'text' },
];

function setup(total: number) {
  const events = new EventEmitter();
  const files = new Map<string, string>();
  const finished: ExportFinished[] = [];
  events.subscribe('exportFinished', (payload) => finished.push(payload));
  const exporter = createMockExport({
    events,
    source: (id) =>
      id === 1
        ? {
            columns,
            loaded: Math.min(total, 10),
            total,
            value: (row, column): Value =>
              column === 0
                ? { kind: 'int', value: String(row + 1) }
                : row % 3 === 2
                  ? { kind: 'null' }
                  : { kind: 'text', value: `n,${String(row)}` },
          }
        : undefined,
    // A table tab `t` of `total` rows; the filter and sort are the mock table data's business.
    table: (tabId) =>
      tabId === 't'
        ? {
            columns,
            loaded: total,
            total,
            value: (row, column): Value =>
              column === 0
                ? { kind: 'int', value: String(row + 1) }
                : { kind: 'text', value: `t${String(row)}` },
          }
        : mockErrors.invalidArgument('This table tab is not open.', 'Onglet pas ouvert.'),
    writeFile: (path, text) => files.set(path, text),
  });
  exporter.setTick(0);
  return { exporter, files, finished };
}

const csv: ExportFormat = {
  format: 'csv',
  options: {
    delimiter: 'comma',
    quote: 'minimal',
    header: true,
    nullText: '',
    lineEnding: 'lf',
    bom: false,
    binary: 'hex',
  },
};

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('the mock export', () => {
  it('writes the whole result past its loaded rows and reports the outcome', async () => {
    const { exporter, files, finished } = setup(50);
    const started = await exporter.commands.startExport({
      source: { kind: 'result', resultId: 1, scope: { kind: 'all' } },
      format: csv,
      path: '/home/ana/out.csv',
    });
    expect(started.status).toBe('ok');
    await waitFor(() => finished.length > 0);
    expect(finished[0]).toMatchObject({ status: 'done', rows: 50, path: '/home/ana/out.csv' });
    const lines = (files.get('/home/ana/out.csv') ?? '').split('\n');
    expect(lines[0]).toBe('id,name');
    expect(lines[1]).toBe('1,"n,0"');
    expect(lines[3]).toBe('3,');
    expect(lines).toHaveLength(52);
  });

  it('exports a selection of the loaded rows and previews it', async () => {
    const { exporter, files, finished } = setup(50);
    const source: ExportSourceSpec = {
      kind: 'result',
      resultId: 1,
      scope: { kind: 'range', rowFrom: 1, rowTo: 99, columns: [1] },
    };
    const preview = await exporter.commands.previewExport(source, csv, 2);
    expect(preview).toEqual({ status: 'ok', data: 'name\n"n,1"\n\n' });
    await exporter.commands.startExport({ source, format: csv, path: '/home/ana/sel.csv' });
    await waitFor(() => finished.length > 0);
    expect(finished[0]?.rows).toBe(9);
    expect(files.get('/home/ana/sel.csv')?.startsWith('name\n"n,1"\n\n')).toBe(true);
  });

  it('exports every row of a table tab, not a page, and previews it', async () => {
    const { exporter, files, finished } = setup(1200);
    const source: ExportSourceSpec = {
      kind: 'table',
      tabId: 't',
      filter: { conditions: [], rawWhere: null },
      sort: [],
    };
    const preview = await exporter.commands.previewExport(source, csv, 2);
    expect(preview).toEqual({ status: 'ok', data: 'id,name\n1,t0\n2,t1\n' });
    await exporter.commands.startExport({ source, format: csv, path: '/home/ana/table.csv' });
    await waitFor(() => finished.length > 0);
    expect(finished[0]).toMatchObject({ status: 'done', rows: 1200 });
    expect(files.get('/home/ana/table.csv')?.split('\n')).toHaveLength(1202);
    expect(
      await exporter.commands.startExport({
        source: { ...source, tabId: 'closed' },
        format: csv,
        path: '/home/ana/x.csv',
      }),
    ).toMatchObject({ status: 'error', error: { code: 'invalidArgument' } });
  });

  it('writes SQL inserts for the engine asked, Markdown, and the rows of an Excel workbook', async () => {
    const { exporter, files, finished } = setup(3);
    const source: ExportSourceSpec = {
      kind: 'result',
      resultId: 1,
      scope: { kind: 'all' },
    };
    const sql: ExportFormat = {
      format: 'sql',
      options: {
        engine: 'mysql',
        schema: 'shop',
        table: 'orders',
        rowsPerStatement: 2,
        lineEnding: 'lf',
      },
    };
    await exporter.commands.startExport({ source, format: sql, path: '/home/ana/rows.sql' });
    await waitFor(() => finished.length > 0);
    expect(files.get('/home/ana/rows.sql')).toBe(
      "INSERT INTO `shop`.`orders` (`id`, `name`) VALUES\n  (1, 'n,0'),\n  (2, 'n,1');\n" +
        'INSERT INTO `shop`.`orders` (`id`, `name`) VALUES\n  (3, NULL);\n',
    );
    const markdown: ExportFormat = {
      format: 'markdown',
      options: { nullText: 'NULL', alignNumbers: true, binary: 'hex', lineEnding: 'lf' },
    };
    expect(await exporter.commands.previewExport(source, markdown, 3)).toEqual({
      status: 'ok',
      data: '| id | name |\n| ---: | --- |\n| 1 | n,0 |\n| 2 | n,1 |\n| 3 | NULL |\n',
    });
    const excel: ExportFormat = { format: 'excel', options: { sheetName: 'S', binary: 'hex' } };
    expect(
      await exporter.commands.startExport({ source, format: excel, path: '/home/ana/rows.csv' }),
    ).toMatchObject({ status: 'error', error: { code: 'invalidArgument' } });
    expect(
      await exporter.commands.startExport({ source, format: excel, path: '/home/ana/rows.xlsx' }),
    ).toMatchObject({ status: 'ok' });
  });

  it('refuses a relative path, a wrong extension and a freed result', async () => {
    const { exporter } = setup(5);
    const request = (resultId: number, path: string) => ({
      source: { kind: 'result', resultId, scope: { kind: 'all' } } as const,
      format: csv,
      path,
    });
    for (const [id, path, code] of [
      [1, 'out.csv', 'invalidArgument'],
      [1, '/home/ana/out.json', 'invalidArgument'],
      [2, '/home/ana/out.csv', 'resultNotFound'],
    ] as const) {
      expect(await exporter.commands.startExport(request(id, path))).toMatchObject({
        status: 'error',
        error: { code },
      });
    }
  });

  it('cancels a running export and leaves no file', async () => {
    const { exporter, files, finished } = setup(100_000);
    exporter.setTick(5);
    const started = await exporter.commands.startExport({
      source: { kind: 'result', resultId: 1, scope: { kind: 'all' } },
      format: csv,
      path: '/home/ana/big.csv',
    });
    if (started.status !== 'ok') throw new Error('did not start');
    await new Promise((r) => setTimeout(r, 20));
    await exporter.commands.cancelExport(started.data.exportId);
    await waitFor(() => finished.length > 0);
    expect(finished[0]?.status).toBe('cancelled');
    expect(files.has('/home/ana/big.csv')).toBe(false);
  });
});
