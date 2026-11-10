import { describe, expect, it } from 'vitest';

import type { CompletionCatalog } from '../../ipc';
import { buildObjectItems } from './objectItems';

const catalog: CompletionCatalog = {
  database: 'app',
  schemas: [
    { name: 'public', system: false },
    { name: 'sales', system: false },
  ],
  searchPath: ['public'],
  typeNames: [],
  relations: [
    { schema: 0, name: 'Orders', kind: 'table', columns: [], columnTypes: [] },
    { schema: 1, name: 'monthly', kind: 'materializedView', columns: [], columnTypes: [] },
  ],
  routines: [{ schema: 0, name: 'total', kind: 'function', arguments: 'int4', returnType: null }],
  foreignKeys: [],
};
const noSchemas: CompletionCatalog = {
  ...catalog,
  schemas: [],
  relations: [{ schema: null, name: 'notes', kind: 'table', columns: [], columnTypes: [] }],
  routines: [],
};

describe('buildObjectItems', () => {
  const names = new Map([['c1', 'local']]);

  it('qualifies the names with their schema and says where the name starts', () => {
    const items = buildObjectItems([{ connectionId: 'c1', database: 'app', catalog }], names);
    expect(items.map((item) => item.text)).toEqual([
      'public.Orders',
      'sales.monthly',
      'public.total',
    ]);
    expect(items[0]).toMatchObject({
      lower: 'public.orders',
      nameStart: 7,
      connectionName: 'local',
      database: 'app',
      objectKind: 'table',
    });
    expect(items[2]).toMatchObject({ objectKind: 'function', signature: 'int4' });
  });

  it('leaves the name alone on an engine without schemas', () => {
    const [item] = buildObjectItems(
      [{ connectionId: 'c1', database: 'main', catalog: noSchemas }],
      names,
    );
    expect(item).toMatchObject({ text: 'notes', nameStart: 0, schema: null });
  });

  it('gives each object a key of its own, stable across builds', () => {
    const first = buildObjectItems([{ connectionId: 'c1', database: 'app', catalog }], names);
    const again = buildObjectItems([{ connectionId: 'c1', database: 'app', catalog }], names);
    expect(new Set(first.map((item) => item.key)).size).toBe(first.length);
    expect(again.map((item) => item.key)).toEqual(first.map((item) => item.key));
  });

  it('indexes a catalog once, and again when its connection is renamed', () => {
    const entry = { connectionId: 'c1', database: 'app', catalog };
    const first = buildObjectItems([entry], names);
    expect(buildObjectItems([entry], names)[0]).toBe(first[0]);
    expect(buildObjectItems([entry], new Map([['c1', 'renamed']]))[0]).not.toBe(first[0]);
  });
});
