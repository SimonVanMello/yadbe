import { describe, expect, it } from 'vitest';

import { cellOf, gridOf, mockDatabases } from './documentData';
import { createMockDocument } from './document';

function backend(readOnly = false, onConfirm: (requestId: number) => void = () => undefined) {
  const stored = new Map<number, string[][]>();
  let next = 1;
  const history: string[] = [];
  const streamed: string[][] = [];
  const mock = createMockDocument({
    session: () => ({ readOnly, topology: 'replicaSet' as const }),
    latency: () => 0,
    logStatement: () => undefined,
    recordHistory: (entry) => history.push(`${entry.outcome}:${entry.sql}`),
    confirm: (request) => {
      onConfirm(request.requestId);
    },
    output: (event) => {
      streamed.push(event.messages.map((m) => m.text));
    },
    storeRows: (_columns, rows) => {
      const id = next++;
      stored.set(
        id,
        rows.map((row) => row.map((cell) => cell?.[1] ?? '')),
      );
      return id;
    },
    freeResults: (ids) => {
      for (const id of ids) stored.delete(id);
    },
    readTexts: (id, offset, limit) =>
      stored
        .get(id)
        ?.slice(offset, offset + limit)
        .map((row) => row[0] ?? '') ?? null,
  });
  return { commands: mock.commands, history, streamed };
}

describe('the mock MongoDB server', () => {
  it('has believable documents: nested, mixed types, missing fields', () => {
    const products = mockDatabases().get('catalog')?.get('products')?.documents ?? [];
    const { columns, rows } = gridOf(products.slice(0, 12));
    const names = columns.map((c) => c.name);
    expect(names[0]).toBe('_id');
    expect(names).toContain('discontinued');
    const stock = columns.find((c) => c.name === 'stock');
    expect(stock?.typeName).toBe('long | int');
    const discontinued = names.indexOf('discontinued');
    expect(rows.some((row) => row[discontinued]?.[0] === 'missing')).toBe(true);
    expect(cellOf({ $date: { $numberLong: '1700000000123' } })).toEqual([
      'timestampTz',
      '2023-11-14 22:13:20.123+00',
    ]);
  });

  it('pages a collection and reads its documents back', async () => {
    const { commands } = backend();
    const query = { filter: '{"status":"paid"}', projection: '', sort: '', pageSize: 50 };
    const page = await commands.mongoFetchPage('t', 'c', 'catalog', 'orders', query, 0);
    if (page.status !== 'ok') throw new Error('page');
    expect(page.data.keyset).toBe(true);
    expect(page.data.documents.count).toBe(50);
    const docs = await commands.mongoFetchDocuments(page.data.documents.documentsId, 0, 2);
    if (docs.status !== 'ok') throw new Error('documents');
    expect(JSON.parse(docs.data[0] ?? '{}')).toMatchObject({ status: 'paid' });
  });

  it('runs a few mongosh statements, refuses writes when read-only, confirms deletes', async () => {
    const { commands } = backend();
    const request = (text: string) => ({ database: 'catalog', text, range: null });
    const found = await commands.mongoRunScript(
      't',
      'c',
      request("print('hi')\ndb.orders.find({ status: 'paid' }).limit(3)"),
    );
    if (found.status !== 'ok') throw new Error('script');
    expect(found.data.messages.map((m) => m.text)).toEqual(['hi']);
    expect(found.data.result).toMatchObject({ kind: 'documents', cursor: true });

    // Printed lines are streamed before the statement that follows them; the last ones come
    // with the outcome only.
    const printing = backend();
    const printed = await printing.commands.mongoRunScript(
      't',
      'c',
      request("print('a')\nprint('b')\nsleep(1)\nprint('c')"),
    );
    if (printed.status !== 'ok') throw new Error('script');
    expect(printing.streamed).toEqual([['a'], ['b']]);
    expect(printed.data.messages.map((m) => m.text)).toEqual(['a', 'b', 'c']);

    const readOnly = backend(true);
    const refused = await readOnly.commands.mongoRunScript(
      't',
      'c',
      request('db.orders.countDocuments()\n  db.orders.insertOne({ a: 1 })'),
    );
    if (refused.status !== 'ok') throw new Error('script');
    expect(refused.data.failure?.error.code).toBe('readOnlyViolation');
    expect(refused.data.failure?.position).toEqual({ line: 2, column: 13, offset: 39 });
    expect(readOnly.history).toEqual([
      'refused:db.orders.countDocuments()\n  db.orders.insertOne({ a: 1 })',
    ]);

    const asked: number[] = [];
    const confirming = backend(false, (requestId) => {
      asked.push(requestId);
      void confirming.commands.mongoScriptConfirm('t', requestId, true);
    });
    const deleted = await confirming.commands.mongoRunScript(
      't',
      'c',
      request('db.orders.deleteMany({})\ndb.orders.countDocuments()'),
    );
    if (deleted.status !== 'ok') throw new Error('script');
    expect(asked).toHaveLength(1);
    expect(deleted.data.result).toEqual({ kind: 'text', text: '0', truncated: false });

    const declining = backend(false, (requestId) => {
      void declining.commands.mongoScriptConfirm('t', requestId, false);
    });
    const declined = await declining.commands.mongoRunScript(
      't',
      'c',
      request('db.orders.deleteMany({})'),
    );
    if (declined.status !== 'ok') throw new Error('script');
    expect(declined.data.failure?.error.code).toBe('cancelled');
  });
});
