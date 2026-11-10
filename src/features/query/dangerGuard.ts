import type { MessageKey } from '../../i18n/i18n';
import type { ConnectionSummary } from '../connections/model';
import type { TextRange } from '../../ipc';
import type { DangerKind, DangerousStatement } from './dangerousStatements';

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
  alterDrop: 'query.guard.alterDrop',
  mergeDelete: 'query.guard.mergeDelete',
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

/** Above this many statements, only the dangerous ones are listed. */
const LIST_ALL_UP_TO = 6;

export interface GuardLine {
  /** Position in the run, from 1. */
  number: number;
  sql: string;
  /** `null`: not flagged, it runs as written like the others. */
  kind: DangerKind | null;
}

/**
 * What the confirmation lists, each statement once: the dangerous ones with what they do, and,
 * for a short script, the harmless ones around them so the flagged ones can be told apart.
 */
export function guardLines(
  text: string,
  ranges: readonly TextRange[],
  dangers: readonly DangerousStatement[],
): GuardLine[] {
  const kinds = new Map(dangers.map((danger) => [danger.index, danger.kind]));
  const all = ranges.length <= LIST_ALL_UP_TO;
  const lines: GuardLine[] = [];
  for (const [index, range] of ranges.entries()) {
    const kind = kinds.get(index) ?? null;
    if (kind === null && !all) continue;
    lines.push({ number: index + 1, sql: text.slice(range.from, range.to).trim(), kind });
  }
  return lines;
}
