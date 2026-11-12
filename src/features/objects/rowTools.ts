import type { DdlTarget, EngineInfo, ObjectKind, ObjectRef, PinnedObject } from '../../ipc';
import { cachedEngineInfo } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import type { ExplorerRow } from '../explorer/explorerRows';
import { findConnection } from '../query/connectionLookup';
import { pinOf, supportOf } from './objectsModel';

/** An object of the explorer a tool can act on, whichever row stands for it. */
export interface ObjectSubject {
  connectionId: string;
  object: ObjectRef;
  kind: ObjectKind;
  /** The object's id in its list (the name, or `name(argument types)` for a routine). */
  id: string;
}

/**
 * The object an object row, or a pinned row whose object is still there, stands for. `null` for
 * every other row: columns, kinds, schemas, a pin that lost its object.
 */
export function objectSubject(row: ExplorerRow): ObjectSubject | null {
  if (row.type === 'object') {
    return {
      connectionId: row.connectionId,
      object: row.ref,
      kind: row.object.kind,
      id: row.object.id,
    };
  }
  if (row.type === 'pinned' && row.pin.kind !== null && !row.missing) {
    return { connectionId: row.connectionId, object: row.ref, kind: row.pin.kind, id: row.pin.id };
  }
  return null;
}

/** The pin a row can be pinned or unpinned as: an object, a schema, a pinned row itself. */
export function pinForRow(row: ExplorerRow): PinnedObject | null {
  switch (row.type) {
    case 'object':
      return pinOf(row.connectionId, row.ref, row.object.kind, row.object.id);
    case 'schema':
      return pinOf(
        row.connectionId,
        { database: row.database, schema: row.schema.name, name: row.schema.name },
        null,
      );
    case 'pinned':
      return row.pin;
    default:
      return null;
  }
}

/** What "Show DDL" opens for a row: an object, one trigger or one index. */
export function ddlTargetForRow(row: ExplorerRow): DdlTarget | null {
  const subject = objectSubject(row);
  if (subject) {
    return { type: 'object', object: subject.object, kind: subject.kind, id: subject.id };
  }
  if (row.type === 'trigger') {
    return { type: 'trigger', table: row.table, name: row.trigger.name };
  }
  if (row.type === 'index') {
    return { type: 'index', table: row.table, name: row.index.name };
  }
  return null;
}

export interface RowTools {
  rename: boolean;
  truncate: boolean;
  drop: boolean;
  /** The connection refuses writes: the tools show disabled, the backend refuses anyway. */
  readOnly: boolean;
}

/** What the engine offers on a kind of object, and whether the connection may write. */
export function toolsFor(
  connection: Pick<ConnectionSummary, 'readOnly'> | undefined,
  engine: Pick<EngineInfo, 'objectActions'> | undefined,
  kind: ObjectKind,
): RowTools {
  const support = supportOf(engine, kind);
  return { ...support, readOnly: connection?.readOnly ?? false };
}

/** The same, read from the caches: for the keyboard, outside React. */
export function toolsOfSubject(subject: ObjectSubject): RowTools {
  const connection = findConnection(subject.connectionId);
  return toolsFor(connection, cachedEngineInfo(connection?.engine), subject.kind);
}
