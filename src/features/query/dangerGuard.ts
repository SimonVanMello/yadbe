import type { MessageKey } from '../../i18n/i18n';
import type { ConnectionSummary } from '../connections/model';
import type { DangerKind } from './dangerousStatements';

/**
 * Whether a run on this connection goes through the dangerous-statement guard (F-051): always on
 * a prod-tagged connection, else when the preference is on. A read-only connection never asks:
 * the backend refuses what would change data, which is a clearer answer than a confirmation.
 */
export function guardApplies(
  connection: Pick<ConnectionSummary, 'environment' | 'readOnly'>,
  confirmDangerous: boolean,
): boolean {
  if (connection.readOnly) return false;
  return connection.environment === 'prod' || confirmDangerous;
}

const KIND_KEYS: Record<DangerKind, MessageKey> = {
  updateWithoutWhere: 'query.guard.updateWithoutWhere',
  deleteWithoutWhere: 'query.guard.deleteWithoutWhere',
  truncate: 'query.guard.truncate',
  drop: 'query.guard.drop',
};

/** Catalog key of the sentence that says what a kind of statement does. */
export function dangerKindKey(kind: DangerKind): MessageKey {
  return KIND_KEYS[kind];
}

/** A statement on one line, shortened for a list; the exact text is shown elsewhere. */
export function oneLine(sql: string, max = 200): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
