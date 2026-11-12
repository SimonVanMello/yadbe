import { describe, expect, it } from 'vitest';

import type { CompletionCatalog, EfMigration, ObjectRef } from '../../ipc';
import { isEfHistoryTable } from './historyTables';
import {
  buildTimeline,
  dayLabel,
  historyTablesOf,
  monthLabel,
  pickHistoryTable,
  spanOf,
} from './migrationsModel';

function migration(id: string, timestamp: string | null, version = '8.0.0'): EfMigration {
  return {
    id,
    name: id.includes('_') && timestamp ? id.slice(id.indexOf('_') + 1) : id,
    timestamp,
    productVersion: version,
  };
}

const list = [
  migration('00000000000000_Legacy', null),
  migration('20230214091200_InitialCreate', '2023-02-14 09:12:00'),
  migration('20230301154501_AddCustomers', '2023-03-01 15:45:01'),
  migration('20230301160000_AddOrders', '2023-03-01 16:00:00'),
  migration('20240608141755_AddAuditColumns', '2024-06-08 14:17:55'),
];

describe('buildTimeline', () => {
  it('lists the newest first, under a heading per month, the undated ones last', () => {
    const rows = buildTimeline(list);
    expect(
      rows.map((row) =>
        row.type === 'month' ? `# ${row.key} (${String(row.count)})` : row.migration.name,
      ),
    ).toEqual([
      '# 2024-06 (1)',
      'AddAuditColumns',
      '# 2023-03 (2)',
      'AddOrders',
      'AddCustomers',
      '# 2023-02 (1)',
      'InitialCreate',
      '# none (1)',
      '00000000000000_Legacy',
    ]);
  });

  it('is empty for an empty history', () => {
    expect(buildTimeline([])).toEqual([]);
  });

  it('keeps a history without any timestamp in one group', () => {
    const rows = buildTimeline([migration('Initial', null), migration('Second', null)]);
    expect(rows[0]).toEqual({ type: 'month', key: 'none', count: 2 });
    expect(rows).toHaveLength(3);
  });
});

describe('spanOf', () => {
  it('gives the first and the last day', () => {
    expect(spanOf(list)).toEqual({ from: '2023-02-14', to: '2024-06-08' });
    expect(spanOf([migration('Initial', null)])).toBeNull();
    expect(spanOf([])).toBeNull();
  });
});

describe('labels', () => {
  it('writes months and days as the locale does', () => {
    expect(monthLabel('2024-06', 'en')).toBe('June 2024');
    expect(monthLabel('2024-06', 'fr')).toBe('juin 2024');
    expect(monthLabel('none', 'en')).toBeNull();
    expect(dayLabel('2024-06-08', 'en')).toBe('Jun 8, 2024');
    expect(dayLabel('not a day', 'en')).toBe('not a day');
  });
});

describe('history table', () => {
  const at = (schema: string | null, name = '__EFMigrationsHistory'): ObjectRef => ({
    database: 'shop',
    schema,
    name,
  });

  it('is recognized whatever its case', () => {
    expect(isEfHistoryTable('__EFMigrationsHistory')).toBe(true);
    expect(isEfHistoryTable('__efmigrationshistory')).toBe(true);
    expect(isEfHistoryTable('migrations')).toBe(false);
  });

  it('prefers the default schema, else the first one found', () => {
    const tables = [at('app'), at('public'), at('public', 'orders')];
    expect(pickHistoryTable(tables, ['public'])).toEqual(at('public'));
    expect(pickHistoryTable(tables, ['dbo'])).toEqual(at('app'));
    expect(pickHistoryTable([at('public', 'orders')], ['public'])).toBeNull();
    expect(pickHistoryTable([at(null)], [])).toEqual(at(null));
  });
});

describe('historyTablesOf', () => {
  it('finds the history table of every schema of a catalog', () => {
    const catalog: CompletionCatalog = {
      database: 'shop',
      schemas: [
        { name: 'public', system: false },
        { name: 'app', system: false },
      ],
      searchPath: ['public'],
      typeNames: [],
      relations: [
        { schema: 0, name: '__EFMigrationsHistory', kind: 'table', columns: [], columnTypes: [] },
        { schema: 1, name: '__EFMigrationsHistory', kind: 'table', columns: [], columnTypes: [] },
        { schema: 1, name: '__EFMigrationsHistory', kind: 'view', columns: [], columnTypes: [] },
        { schema: 0, name: 'orders', kind: 'table', columns: [], columnTypes: [] },
      ],
      routines: [],
      foreignKeys: [],
    };
    expect(historyTablesOf(catalog)).toEqual([
      { database: 'shop', schema: 'public', name: '__EFMigrationsHistory' },
      { database: 'shop', schema: 'app', name: '__EFMigrationsHistory' },
    ]);
  });
});
