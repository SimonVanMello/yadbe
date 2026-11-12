import type {
  ColumnMeta,
  ResultEditInfo,
  ResultReadOnlyReason,
  TableDataInfo,
  TransactionState,
} from '../../ipc';
import type { GridColumn } from '../grid/rowSource';

/**
 * Editable query results (F-087), the pure part: how a result's edit description becomes the
 * table description the table-tab machinery edits with, and why a result cannot be edited.
 */

/** The edit session of a result: not a shell tab id (table tabs use theirs). */
export function sessionIdOf(resultId: number): string {
  return `result:${String(resultId)}`;
}

/** The result of an edit session id, `null` for a table tab. */
export function resultIdOf(sessionId: string): number | null {
  const match = /^result:(\d+)$/.exec(sessionId);
  return match ? Number(match[1]) : null;
}

/**
 * The table description of an editable result: one column per result column (a computed one
 * read-only), the row identity, no foreign keys (navigation stays in table tabs), no inserts.
 */
export function toTableInfo(info: ResultEditInfo): TableDataInfo | null {
  if (!info.table || info.readOnlyReasons.length > 0) return null;
  return {
    table: info.table,
    kind: 'table',
    columns: info.columns.map((c) => c.column),
    rowIdentity: info.rowIdentity,
    readOnlyReasons: [],
    defaultOrder: [],
    rowEstimate: null,
    foreignKeys: [],
  };
}

/**
 * The grid columns of an editable result: the result's own names and types, the reason a
 * column cannot be written on its header.
 */
export function gridColumnsOf(
  columns: readonly ColumnMeta[],
  info: ResultEditInfo,
  reasonText: (column: ResultEditInfo['columns'][number]) => string | null,
): GridColumn[] {
  return columns.map((meta, i) => {
    const column = info.columns[i];
    return {
      name: meta.name,
      typeName: meta.typeName,
      kind: meta.kind,
      readOnlyReason: column ? reasonText(column) : null,
    };
  });
}

/**
 * Why a result cannot be edited now: what the backend said, then the query tab's open
 * transaction (it changes while the result is on screen).
 */
export function readOnlyReasons(
  info: ResultEditInfo | null,
  transaction: TransactionState,
): ResultReadOnlyReason[] {
  const reasons = [...(info?.readOnlyReasons ?? [])];
  if (info && reasons.length === 0 && transaction.status !== 'idle') {
    reasons.push('openTransaction');
  }
  return reasons;
}

/** A short name of a table: `schema.name`, or the name alone. */
export function tableName(info: ResultEditInfo): string {
  const table = info.table;
  if (!table) return '';
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}
