import type { CompletionCatalog } from '../../ipc';
import type { LoadedCatalog } from '../explorer/catalogCache';
import { objectKey, type ObjectItem } from './paletteItems';

/** What a connection's name is shown as, by connection id. */
export type ConnectionNames = ReadonlyMap<string, string>;

function itemsOf(
  connectionId: string,
  connectionName: string,
  catalog: CompletionCatalog,
): ObjectItem[] {
  const database = catalog.database;
  const items: ObjectItem[] = [];
  const push = (
    schemaIndex: number | null,
    name: string,
    kind: ObjectItem['objectKind'],
    signature: string | null,
  ) => {
    const schema = schemaIndex === null ? null : (catalog.schemas[schemaIndex]?.name ?? null);
    const text = schema === null ? name : `${schema}.${name}`;
    items.push({
      kind: 'object',
      key: objectKey(connectionId, database, schema, kind, name, signature),
      text,
      lower: text.toLowerCase(),
      nameStart: schema === null ? 0 : schema.length + 1,
      connectionId,
      connectionName,
      database,
      schema,
      name,
      objectKind: kind,
      signature,
    });
  };
  // The shared catalog carries the engine's own objects for the autocomplete; the palette
  // searches the user's.
  const isSystem = (schemaIndex: number | null, name: string) =>
    schemaIndex === null
      ? name.startsWith('sqlite_')
      : (catalog.schemas[schemaIndex]?.system ?? false);
  for (const relation of catalog.relations) {
    if (isSystem(relation.schema, relation.name)) continue;
    push(relation.schema, relation.name, relation.kind, null);
  }
  for (const routine of catalog.routines) {
    if (isSystem(routine.schema, routine.name)) continue;
    push(routine.schema, routine.name, routine.kind, routine.arguments);
  }
  return items;
}

interface Built {
  connectionName: string;
  items: ObjectItem[];
}

// One build per catalog, for as long as the catalog is in the query cache: opening the palette
// again, or typing, never indexes 10 000 objects twice.
const built = new WeakMap<CompletionCatalog, Built>();

/** Tables, views and routines of the loaded catalogs, ready to search (connection by connection). */
export function buildObjectItems(
  catalogs: readonly LoadedCatalog[],
  names: ConnectionNames,
): ObjectItem[] {
  const all: ObjectItem[] = [];
  for (const { connectionId, catalog } of catalogs) {
    const connectionName = names.get(connectionId) ?? connectionId;
    let entry = built.get(catalog);
    if (entry?.connectionName !== connectionName) {
      entry = { connectionName, items: itemsOf(connectionId, connectionName, catalog) };
      built.set(catalog, entry);
    }
    for (const item of entry.items) all.push(item);
  }
  return all;
}
