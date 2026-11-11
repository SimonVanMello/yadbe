import type { MessageKey } from '../../i18n/i18n';
import type {
  DdlTarget,
  DependencyLink,
  EngineInfo,
  ObjectActionSupport,
  ObjectKind,
  ObjectProperties,
  ObjectRef,
  PinnedObject,
  TableDetails,
} from '../../ipc';
import { formatBytes } from '../export/exportOptions';

/** What a DDL tab or a properties panel is about, in words and in a key. */
export type ToolKind = ObjectKind | 'trigger' | 'index' | 'schema';

const KIND_KEYS: Record<ToolKind, MessageKey> = {
  table: 'objects.kind.table',
  view: 'objects.kind.view',
  materializedView: 'objects.kind.materializedView',
  function: 'objects.kind.function',
  procedure: 'objects.kind.procedure',
  sequence: 'objects.kind.sequence',
  type: 'objects.kind.type',
  trigger: 'objects.kind.trigger',
  index: 'objects.kind.index',
  schema: 'objects.kind.schema',
};

export function toolKindKey(kind: ToolKind): MessageKey {
  return KIND_KEYS[kind];
}

/** The object a DDL target is about: a trigger or an index belongs to its table. */
export function ddlTargetObject(target: DdlTarget): ObjectRef {
  return target.type === 'object' ? target.object : target.table;
}

export function ddlTargetKind(target: DdlTarget): ToolKind {
  return target.type === 'object' ? target.kind : target.type;
}

/** The name shown on the tab: the object's own, or the trigger's or index's. */
export function ddlTargetName(target: DdlTarget): string {
  switch (target.type) {
    case 'object':
      return target.object.name;
    case 'trigger':
    case 'index':
      return target.name;
  }
}

/** Same target: a DDL tab is reused rather than opened twice. */
export function sameDdlTarget(a: DdlTarget, b: DdlTarget): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function sameObject(a: ObjectRef, b: ObjectRef): boolean {
  return a.database === b.database && a.schema === b.schema && a.name === b.name;
}

// --- Actions --------------------------------------------------------------------------------

export type ActionName = 'drop' | 'truncate' | 'rename';

/** What the engine offers on a kind of object; nothing for a kind it lacks. */
export function supportOf(
  info: Pick<EngineInfo, 'objectActions'> | undefined,
  kind: ObjectKind,
): ObjectActionSupport {
  return (
    info?.objectActions.find((entry) => entry.kind === kind) ?? {
      kind,
      drop: false,
      truncate: false,
      rename: false,
    }
  );
}

/**
 * Whether the confirmation asks for the object's name: dropping or truncating on a production
 * connection (F-026). A rename is reversible by renaming back.
 */
export function needsTypedName(environment: string | null, action: ActionName): boolean {
  return environment === 'prod' && action !== 'rename';
}

/** The typed text names the object exactly (case and spaces count: they are part of a name). */
export function nameConfirmed(typed: string, name: string): boolean {
  return typed === name;
}

// --- Dependencies ---------------------------------------------------------------------------

export function dependencyKey(link: DependencyLink | null): MessageKey | null {
  if (link === null) return null;
  return link.type === 'foreignKey'
    ? 'objects.action.dependents.foreignKey'
    : 'objects.action.dependents.column';
}

// --- Properties -----------------------------------------------------------------------------

export interface Fact {
  key: MessageKey;
  value: string;
  /** Said once more as a note under the value. */
  hint?: MessageKey;
}

/**
 * The facts to show, in a fixed order: the ones the engine did not give are left out, never
 * shown empty.
 */
export function factsOf(
  properties: ObjectProperties,
  locale: string,
  formatCount: (n: number) => string,
): Fact[] {
  const facts: Fact[] = [];
  const add = (key: MessageKey, value: string | null, hint?: MessageKey) => {
    if (value !== null && value.trim() !== '') facts.push({ key, value, ...(hint ? { hint } : {}) });
  };
  const bytes = (n: number | null) => (n === null ? null : formatBytes(n, locale));
  add('objects.props.owner', properties.owner);
  add(
    'objects.props.rowEstimate',
    properties.rowEstimate === null ? null : formatCount(Math.round(properties.rowEstimate)),
    'objects.props.rowEstimateHint',
  );
  add('objects.props.dataSize', bytes(properties.dataBytes));
  add('objects.props.indexSize', bytes(properties.indexBytes));
  add('objects.props.totalSize', bytes(properties.totalBytes));
  add('objects.props.storageEngine', properties.storageEngine);
  add('objects.props.collation', properties.collation);
  add('objects.props.created', properties.created);
  add('objects.props.modified', properties.modified);
  add('objects.props.lastAnalyzed', properties.lastAnalyzed);
  add('objects.props.lastVacuumed', properties.lastVacuumed);
  add('objects.props.comment', properties.comment);
  return facts;
}

export interface StructureLine {
  key: MessageKey;
  /** Names listed after the count. */
  names: string[];
  count: number;
}

/** Columns, keys, indexes and the like of a relation, counted and named. */
export function structureOf(details: TableDetails): StructureLine[] {
  const lines: StructureLine[] = [
    {
      key: 'objects.props.columns',
      count: details.columns.length,
      names: details.columns.map((c) => c.name),
    },
  ];
  const push = (key: MessageKey, names: string[]) => {
    if (names.length > 0) lines.push({ key, count: names.length, names });
  };
  push('objects.props.primaryKey', details.primaryKey?.columns ?? []);
  push(
    'objects.props.uniqueKeys',
    details.uniqueKeys.map((k) => k.name ?? k.columns.join(', ')),
  );
  push(
    'objects.props.foreignKeys',
    details.foreignKeys.map((k) => k.name ?? k.columns.join(', ')),
  );
  push(
    'objects.props.indexes',
    details.indexes.filter((i) => !i.primary).map((i) => i.name),
  );
  push(
    'objects.props.checks',
    details.checks.map((c) => c.name ?? c.expression),
  );
  push(
    'objects.props.triggers',
    details.triggers.map((trigger) => trigger.name),
  );
  return lines;
}

// --- Pins -----------------------------------------------------------------------------------

export function samePin(a: PinnedObject, b: PinnedObject): boolean {
  return (
    a.connectionId === b.connectionId &&
    a.database === b.database &&
    a.schema === b.schema &&
    a.kind === b.kind &&
    a.id === b.id
  );
}

/** The pin of an object, as the store keeps it. */
export function pinOf(
  connectionId: string,
  object: ObjectRef,
  kind: ObjectKind | null,
  id: string = object.name,
): PinnedObject {
  return {
    connectionId,
    database: object.database,
    schema: object.schema,
    kind,
    name: object.name,
    id: kind === null ? object.name : id,
  };
}

/** The address of a pinned object (a schema pin is the schema itself: `name` is its name). */
export function pinnedRef(pin: PinnedObject): ObjectRef {
  return { database: pin.database, schema: pin.schema, name: pin.name };
}
