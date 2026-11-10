import { beforeAll, describe, expect, it } from 'vitest';

import type { TableDetails } from '../../ipc';
import { CatalogIndex } from './catalogIndex';
import { buildInfo, type InfoEnv } from './completionInfo';
import { mockCatalog } from './completionTestKit';

let index: CatalogIndex;

beforeAll(async () => {
  index = new CatalogIndex(await mockCatalog());
});

function details(nullable: boolean, primaryKey: boolean): TableDetails {
  return {
    table: { database: 'app_dev', schema: 'shop', name: 'orders' },
    kind: 'table',
    comment: null,
    rowEstimate: null,
    columns: [
      {
        name: 'customer_id',
        ordinal: 2,
        typeName: 'integer',
        kind: 'int',
        nullable,
        default: null,
        identity: null,
        generated: null,
        comment: 'Who placed the order',
        primaryKey,
        foreignKey: true,
      },
    ],
    primaryKey: null,
    uniqueKeys: [],
    foreignKeys: [],
    checks: [],
    indexes: [],
    triggers: [],
  };
}

const env = (overrides: Partial<InfoEnv> = {}): InfoEnv => ({
  index,
  locale: 'en',
  tableDetails: () => Promise.resolve(null),
  ...overrides,
});

describe('the info of a relation', () => {
  it('names it with its schema and lists its columns with their types', () => {
    const orders = index.resolve(['shop', 'orders']);
    const node = buildInfo({ type: 'relation', relation: orders }, env());
    expect(node?.querySelector('.cm-yadbe-info-title')?.textContent).toBe('shop.orders');
    const rows = [...(node?.querySelectorAll('.cm-yadbe-info-column') ?? [])].map(
      (row) => row.textContent,
    );
    expect(rows).toContain('customer_idinteger');
    expect(rows).toHaveLength(10);
  });

  it('cuts a long list and counts what is left, in the language of the UI', () => {
    // The shop has no wide table: build one.
    const catalog = {
      ...index.catalog,
      relations: [
        {
          schema: null,
          name: 'wide',
          kind: 'table' as const,
          columns: Array.from({ length: 30 }, (_, i) => `c${String(i)}`),
          columnTypes: Array.from({ length: 30 }, () => 0),
        },
      ],
      foreignKeys: [],
    };
    const wideIndex = new CatalogIndex(catalog);
    const node = buildInfo({ type: 'relation', relation: 0 }, env({ index: wideIndex }));
    expect(node?.querySelectorAll('.cm-yadbe-info-column')).toHaveLength(24);
    expect(node?.querySelector('.cm-yadbe-info-more')?.textContent).toBe('6 more columns');
    const french = buildInfo(
      { type: 'relation', relation: 0 },
      env({ index: wideIndex, locale: 'fr' }),
    );
    expect(french?.querySelector('.cm-yadbe-info-more')?.textContent).toBe('6 colonnes de plus');
  });

  it('is nothing without a catalog', () => {
    expect(buildInfo({ type: 'relation', relation: 0 }, env({ index: null }))).toBeNull();
  });
});

describe('the info of a column', () => {
  const orders = () => index.resolve(['shop', 'orders']);
  const column = () =>
    ({ type: 'column', relation: orders(), column: 'customer_id', typeName: 'integer' }) as const;

  it('shows what the catalog knows at once: type, table, referenced table', () => {
    const node = buildInfo(column(), env());
    const text = node?.textContent ?? '';
    expect(text).toContain('customer_id');
    expect(text).toContain('integer');
    expect(text).toContain('shop.orders');
    expect(text).toContain('References');
    expect(text).toContain('shop.customers (id)');
  });

  it('adds nullability, keys and comment when the table details arrive', async () => {
    const node = buildInfo(
      column(),
      env({ tableDetails: () => Promise.resolve(details(false, true)) }),
    );
    expect(node?.textContent).not.toContain('Not null');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(node?.textContent).toContain('Not null · Primary key');
    expect(node?.textContent).toContain('Who placed the order');
    const nullable = buildInfo(
      column(),
      env({ tableDetails: () => Promise.resolve(details(true, false)) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nullable?.textContent).toContain('Nullable');
    expect(nullable?.textContent).not.toContain('Primary key');
  });

  it('stays as it is when the details cannot be read', async () => {
    const node = buildInfo(column(), env());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(node?.textContent).not.toContain('Constraints');
    expect(node?.textContent).toContain('integer');
  });

  it('asks for the details of the right table', () => {
    let asked: unknown;
    buildInfo(
      column(),
      env({
        tableDetails: (table, kind) => {
          asked = { table, kind };
          return Promise.resolve(null);
        },
      }),
    );
    expect(asked).toEqual({
      table: { database: 'app_dev', schema: 'shop', name: 'orders' },
      kind: 'table',
    });
  });

  it('shows only the type for the column of a CTE', () => {
    const node = buildInfo({ type: 'column', relation: null, column: 'x', typeName: null }, env());
    expect(node?.textContent).toBe('x');
  });
});

describe('the info of a routine and of a CTE', () => {
  it('shows the signature and what it returns', () => {
    const routine = index.catalog.routines.findIndex((r) => r.name === 'order_total');
    const node = buildInfo({ type: 'routine', routine }, env());
    expect(node?.querySelector('.cm-yadbe-info-title')?.textContent).toMatch(
      /^shop\.order_total\(/,
    );
    expect(node?.textContent).toContain('Returns');
  });

  it('lists the columns of a CTE or subquery', () => {
    const node = buildInfo(
      {
        type: 'columns',
        name: 'big',
        columns: [
          { name: 'id', typeName: null },
          { name: 'total', typeName: null },
        ],
      },
      env(),
    );
    expect(node?.querySelector('.cm-yadbe-info-title')?.textContent).toBe('big');
    expect(node?.querySelectorAll('.cm-yadbe-info-column')).toHaveLength(2);
  });
});
