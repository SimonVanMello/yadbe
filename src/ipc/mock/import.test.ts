import { describe, expect, it } from 'vitest';

import type {
  ColumnInfo,
  ImportFinished,
  ImportRequest,
  ObjectRef,
  TableDetails,
} from '../bindings';
import { EventEmitter } from '../emitter';
import { createMockImport } from './import';
import { DEFAULT_PARSE_OPTIONS } from './importParse';

const table: ObjectRef = { database: 'shop', schema: 'public', name: 'orders' };

function column(name: string, typeName: string, kind: ColumnInfo['kind'], extra = {}): ColumnInfo {
  return {
    name,
    ordinal: 1,
    typeName,
    kind,
    nullable: true,
    default: null,
    identity: null,
    generated: null,
    comment: null,
    primaryKey: false,
    foreignKey: false,
    ...extra,
  };
}

const details: TableDetails = {
  table,
  kind: 'table',
  comment: null,
  rowEstimate: null,
  columns: [
    column('id', 'integer', 'int', { nullable: false, primaryKey: true }),
    column('email', 'varchar(12)', 'text', { nullable: false }),
    column('total', 'numeric(8,2)', 'decimal'),
    column('seq', 'integer', 'int', { identity: 'always', nullable: false }),
  ],
  primaryKey: { name: 'pk', columns: ['id'] },
  uniqueKeys: [],
  foreignKeys: [],
  checks: [],
  indexes: [],
  triggers: [],
};

function setup(files: Record<string, string>, readOnly = false) {
  const events = new EventEmitter();
  const disk = new Map(Object.entries(files));
  const finished: ImportFinished[] = [];
  const log: string[] = [];
  events.subscribe('importFinished', (payload) => finished.push(payload));
  const importer = createMockImport({
    events,
    readFile: (path) => disk.get(path),
    writeFile: (path, text) => disk.set(path, text),
    relation: (_, wanted) => (wanted.name === 'orders' ? { details } : null),
    session: (id) => (id === 'c' ? { engine: 'postgres', readOnly } : null),
    logStatement: (_, sql) => log.push(sql),
  });
  importer.setTick(0);
  return { importer, disk, finished, log };
}

const request = (over: Partial<ImportRequest> = {}): ImportRequest => ({
  connectionId: 'c',
  table,
  path: '/data/orders.csv',
  parse: DEFAULT_PARSE_OPTIONS,
  mapping: [
    { column: 'id', source: { kind: 'file', index: 0 } },
    { column: 'email', source: { kind: 'file', index: 1 } },
    { column: 'total', source: { kind: 'file', index: 2 } },
  ],
  convert: { decimalSeparator: 'dot', binary: 'hex' },
  onError: 'skip',
  commit: 'single',
  dryRun: false,
  rejectsPath: null,
  ...over,
});

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
};

const CSV =
  'id,email,total\n1,a@x.io,10.50\n2,b@x.io,abc\n3,this-is-too-long@x.io,1\n1,dup@x.io,2\n';

describe('the mock import', () => {
  it('previews a file with detected options and with given ones', async () => {
    const { importer } = setup({ '/data/orders.csv': CSV, '/data/semi.txt': 'a;b\n1;2\n' });
    const detected = await importer.commands.previewImportFile('/data/orders.csv', null, 2);
    expect(detected).toMatchObject({
      status: 'ok',
      data: {
        columns: ['id', 'email', 'total'],
        rows: [
          ['1', 'a@x.io', '10.50'],
          ['2', 'b@x.io', 'abc'],
        ],
      },
    });
    const semi = await importer.commands.previewImportFile('/data/semi.txt', null, 5);
    expect(semi.status === 'ok' && semi.data.options.delimiter).toBe('semicolon');
    const missing = await importer.commands.previewImportFile('/data/nope.csv', null, 5);
    expect(missing).toMatchObject({ status: 'error', error: { code: 'fileNotFound' } });
    const relative = await importer.commands.previewImportFile('data.csv', null, 5);
    expect(relative).toMatchObject({ status: 'error', error: { code: 'invalidArgument' } });
    const wrongType = await importer.commands.previewImportFile('/data/x.exe', null, 5);
    expect(wrongType).toMatchObject({ status: 'error', error: { code: 'invalidArgument' } });
  });

  it('describes the target and counts the values that will not convert', async () => {
    const { importer } = setup({ '/data/orders.csv': CSV });
    const target = await importer.commands.getImportTarget('c', table);
    expect(target.status === 'ok' && target.data.columns.map((c) => c.readOnlyReason)).toEqual([
      null,
      null,
      null,
      'identity',
    ]);
    const analysis = await importer.commands.analyzeImport(request());
    expect(analysis.status).toBe('ok');
    if (analysis.status !== 'ok') return;
    expect(analysis.data.rowsExamined).toBe(4);
    const byName = Object.fromEntries(analysis.data.columns.map((c) => [c.column, c]));
    expect(byName['total']?.invalid).toBe(1);
    expect(byName['total']?.samples[0]).toMatchObject({
      line: 3,
      value: 'abc',
      reason: 'invalidFormat',
    });
    expect(byName['email']?.samples[0]?.reason).toBe('tooLong');
    expect(analysis.data.missingRequired).toEqual([]);
  });

  it('skips bad rows, reports them and writes the rejects file', async () => {
    const { importer, finished, disk } = setup({ '/data/orders.csv': CSV });
    const started = await importer.commands.startImport(
      request({ rejectsPath: '/data/rejects.csv' }),
    );
    expect(started.status).toBe('ok');
    await waitFor(() => finished.length > 0);
    const done = finished[0];
    expect(done).toMatchObject({ status: 'done', rowsRead: 4, inserted: 1, kept: 1, rejected: 3 });
    expect(done?.rejectSamples.map((r) => [r.line, r.reason])).toEqual([
      [3, 'invalidFormat'],
      [4, 'tooLong'],
      [5, 'constraint'],
    ]);
    expect(disk.get('/data/rejects.csv')).toContain('3,"invalidFormat');
  });

  it('stops at the first bad row, rolls back, and a dry run keeps nothing', async () => {
    const { importer, finished, log } = setup({ '/data/orders.csv': CSV });
    await importer.commands.startImport(request({ onError: 'stop' }));
    await waitFor(() => finished.length > 0);
    expect(finished[0]).toMatchObject({
      status: 'failed',
      kept: 0,
      error: { code: 'importRejected' },
    });
    expect(log).toContain('ROLLBACK');
    await importer.commands.startImport(request({ dryRun: true }));
    await waitFor(() => finished.length > 1);
    expect(finished[1]).toMatchObject({ status: 'done', dryRun: true, inserted: 1, kept: 0 });
    expect(log.filter((sql) => sql.startsWith('INSERT'))[0]).toContain('/* import:');
  });

  it('refuses what the backend refuses', async () => {
    const readOnly = setup({ '/data/orders.csv': CSV }, true).importer;
    expect(await readOnly.commands.startImport(request())).toMatchObject({
      status: 'error',
      error: { code: 'readOnlyViolation' },
    });
    const { importer } = setup({ '/data/orders.csv': CSV });
    const identity = request({
      mapping: [{ column: 'seq', source: { kind: 'file', index: 0 } }],
    });
    expect(await importer.commands.startImport(identity)).toMatchObject({
      status: 'error',
      error: { code: 'invalidArgument' },
    });
    const onlyTotal = request({
      mapping: [{ column: 'total', source: { kind: 'file', index: 2 } }],
    });
    expect(await importer.commands.startImport(onlyTotal)).toMatchObject({
      status: 'error',
      error: { code: 'invalidArgument' },
    });
    const noConnection = request({ connectionId: 'other' });
    expect(await importer.commands.startImport(noConnection)).toMatchObject({
      status: 'error',
      error: { code: 'notConnected' },
    });
  });

  it('cancels a running import', async () => {
    let rows = 'id,email,total\n';
    for (let i = 1; i <= 9000; i++) rows += `${String(i)},u${String(i)}@x.io,1\n`;
    const { importer, finished } = setup({ '/data/orders.csv': rows });
    importer.setTick(20);
    const started = await importer.commands.startImport(request());
    if (started.status !== 'ok') throw new Error('did not start');
    await new Promise((r) => setTimeout(r, 30));
    await importer.commands.cancelImport(started.data.importId);
    await waitFor(() => finished.length > 0);
    expect(finished[0]).toMatchObject({ status: 'cancelled', kept: 0, error: null });
  });
});
