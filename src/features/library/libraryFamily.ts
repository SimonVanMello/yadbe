import type { MessageKey } from '../../i18n/i18n';
import type { EngineFamily } from '../../ipc';
import type { ConnectionSummary } from '../connections/model';

/** The families in the order the Saved view lists them. */
export const FAMILIES: readonly EngineFamily[] = ['sql', 'document', 'keyValue', 'search'];

const LABELS: Record<EngineFamily, MessageKey> = {
  sql: 'library.family.sql',
  document: 'library.family.document',
  keyValue: 'library.family.keyValue',
  search: 'library.family.search',
};

/** The i18n key of a family's name: the kind of text a saved query holds. */
export function familyLabelKey(family: EngineFamily): MessageKey {
  return LABELS[family];
}

/** The families some query of `queries` is written in, in listing order. */
export function familiesPresent(queries: readonly { family: EngineFamily }[]): EngineFamily[] {
  const present = new Set(queries.map((query) => query.family));
  return FAMILIES.filter((family) => present.has(family));
}

/**
 * The connection a saved query of `family` opens on, among `connections`: the active tab's when it
 * speaks the family, else the first connection that does (`switched`: it is not the one the user
 * is on). `null` when the tab has no connection (the user has to pick one first) or none speaks
 * the family.
 */
export function hostConnection(
  family: EngineFamily,
  connections: readonly ConnectionSummary[],
  activeConnectionId: string | null,
): { connection: ConnectionSummary; switched: boolean } | null {
  const active = connections.find((connection) => connection.id === activeConnectionId);
  if (active === undefined) return null;
  if (active.family === family) return { connection: active, switched: false };
  const other = connections.find((connection) => connection.family === family);
  return other ? { connection: other, switched: true } : null;
}
