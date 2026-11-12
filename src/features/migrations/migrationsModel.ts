import type { CompletionCatalog, EfMigration, ObjectRef } from '../../ipc';
import { isEfHistoryTable } from './historyTables';

/** What the timeline draws, from the newest migration to the oldest. */
export type TimelineRow =
  | {
      type: 'month';
      /** `2024-06`, or `none` for the migrations whose id has no timestamp. */
      key: string;
      count: number;
    }
  | { type: 'migration'; migration: EfMigration };

/**
 * The timeline of a history, newest first, with a heading before each month. Migrations without
 * a timestamp (`00000000000000_Seed`, hand-written ids) come last under their own heading:
 * their place in time is unknown, and the order of the ids is the one the server gave.
 */
export function buildTimeline(migrations: readonly EfMigration[]): TimelineRow[] {
  const dated = migrations.filter((m) => m.timestamp !== null);
  const undated = migrations.filter((m) => m.timestamp === null);
  const rows: TimelineRow[] = [];
  const newestFirst = [...dated].sort((a, b) =>
    (b.timestamp ?? '').localeCompare(a.timestamp ?? ''),
  );
  const groups = new Map<string, EfMigration[]>();
  for (const migration of newestFirst) {
    const key = (migration.timestamp ?? '').slice(0, 7);
    groups.set(key, [...(groups.get(key) ?? []), migration]);
  }
  for (const [key, group] of groups) {
    rows.push({ type: 'month', key, count: group.length });
    for (const migration of group) rows.push({ type: 'migration', migration });
  }
  if (undated.length > 0) {
    rows.push({ type: 'month', key: 'none', count: undated.length });
    for (const migration of [...undated].reverse()) rows.push({ type: 'migration', migration });
  }
  return rows;
}

/** The first and last timestamps of a history (`2023-02-14`), `null` when none has one. */
export function spanOf(migrations: readonly EfMigration[]): { from: string; to: string } | null {
  const days = migrations
    .map((m) => m.timestamp?.slice(0, 10))
    .filter((day): day is string => day !== undefined)
    .sort();
  const from = days[0];
  const to = days.at(-1);
  return from !== undefined && to !== undefined ? { from, to } : null;
}

/** `2024-06` as the locale writes a month (`June 2024`), `null` for the undated group. */
export function monthLabel(key: string, locale: string): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return date.toLocaleDateString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** `2024-06-08` as the locale writes a day. */
export function dayLabel(day: string, locale: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString(locale, { dateStyle: 'medium', timeZone: 'UTC' });
}

/**
 * The history table to open when there is a choice (one per schema): the one in the default
 * schema, else the first. `null` when there is none.
 */
export function pickHistoryTable(
  tables: readonly ObjectRef[],
  defaultSchemas: readonly string[],
): ObjectRef | null {
  const history = tables.filter((table) => isEfHistoryTable(table.name));
  for (const schema of defaultSchemas) {
    const found = history.find((table) => table.schema === schema);
    if (found) return found;
  }
  return history[0] ?? null;
}

/** The history tables of a database's catalog: one per schema that holds one. */
export function historyTablesOf(catalog: CompletionCatalog): ObjectRef[] {
  return catalog.relations
    .filter((relation) => relation.kind === 'table' && isEfHistoryTable(relation.name))
    .map((relation) => ({
      database: catalog.database,
      schema: relation.schema === null ? null : (catalog.schemas[relation.schema]?.name ?? null),
      name: relation.name,
    }));
}
