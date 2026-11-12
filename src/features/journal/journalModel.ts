import type { MessageKey, MessageParams } from '../../i18n/i18n';
import type { JournalEntry, JournalQuery, ObjectRef, Qualifier, RevertBlocker } from '../../ipc';
import { tableLabel } from '../table-data/tableNames';

/** What the Journal view filters on (F-090). */
export interface JournalFilters {
  text: string;
  connectionId: string | null;
  /** A table of that connection (`connectionId` is set with it). */
  table: ObjectRef | null;
}

export const EMPTY_JOURNAL_FILTERS: JournalFilters = { text: '', connectionId: null, table: null };

export function isJournalFiltered(filters: JournalFilters): boolean {
  return filters.text.trim() !== '' || filters.connectionId !== null || filters.table !== null;
}

/** The backend query of the filters (without paging). */
export function toJournalQuery(filters: JournalFilters): JournalQuery {
  const text = filters.text.trim();
  return {
    text: text === '' ? null : text,
    connectionId: filters.connectionId,
    table: filters.table,
    after: null,
    limit: null,
  };
}

/** `schema.table` (`database.table` on MySQL), or the table alone. */
export function tableText(table: ObjectRef, qualifier: Qualifier): string {
  return tableLabel(table, qualifier);
}

/** A stable key of a table, for a select. */
export function tableKey(table: ObjectRef): string {
  return JSON.stringify([table.database, table.schema, table.name]);
}

/** Whether an entry can be reverted now, and if not why. */
export type RevertState =
  | { kind: 'revertible' }
  | { kind: 'reverted'; by: number }
  | { kind: 'blocked'; blocker: RevertBlocker };

export function revertState(entry: JournalEntry): RevertState {
  if (entry.revertedBy !== null) return { kind: 'reverted', by: entry.revertedBy };
  if (entry.revertBlocker) return { kind: 'blocked', blocker: entry.revertBlocker };
  return { kind: 'revertible' };
}

/** The sentence explaining why a change set cannot be reverted faithfully. */
export function blockerMessage(blocker: RevertBlocker): {
  key: MessageKey;
  params?: MessageParams;
} {
  switch (blocker.kind) {
    case 'originalUnknown':
    case 'unwritableColumn':
    case 'identityNotRestorable':
      return { key: `journal.blocker.${blocker.kind}`, params: { column: blocker.column } };
    case 'columnsNotLoaded':
      return {
        key: 'journal.blocker.columnsNotLoaded',
        params: { columns: blocker.columns.join(', ') },
      };
    default:
      return { key: `journal.blocker.${blocker.kind}` };
  }
}

/** The non-zero counts of an entry, as message keys. */
export function countParts(
  entry: Pick<JournalEntry, 'updated' | 'inserted' | 'deleted'>,
): { key: MessageKey; count: number }[] {
  return (
    [
      { key: 'journal.count.updated', count: entry.updated },
      { key: 'journal.count.inserted', count: entry.inserted },
      { key: 'journal.count.deleted', count: entry.deleted },
    ] as const
  ).filter((part) => part.count > 0);
}
