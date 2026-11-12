import type { DocCollection, KvBytes } from '../../ipc';
import { searchable } from './matcher';
import type { FamilyObject, ObjectItem } from './paletteItems';

/**
 * The objects of the non-SQL families as palette items: the collections of the databases the
 * connection works in (MongoDB), the indices, data streams and aliases of the cluster
 * (Elasticsearch, OpenSearch). They come from the explorer's own metadata queries, so nothing is
 * read for the palette that the explorer did not already read. System ones are left out, as the
 * SQL catalog's are.
 */

/** What an index, a data stream and an alias have in common. */
interface Named {
  name: string;
  system: boolean;
}

function familyItem(
  connectionId: string,
  connectionName: string,
  database: string,
  name: string,
  family: FamilyObject,
): ObjectItem {
  return {
    kind: 'object',
    key: `object:${[connectionId, database, family.type, name].join('\u001f')}`,
    ...searchable(name),
    connectionId,
    connectionName,
    database,
    schema: null,
    name,
    objectKind: 'table',
    signature: null,
    family,
  };
}

/** A key the backend found among those it scanned (database by number). */
export function keyItem(
  connectionId: string,
  connectionName: string,
  database: number,
  key: KvBytes,
): ObjectItem {
  return {
    ...familyItem(connectionId, connectionName, `db${String(database)}`, key.text, {
      type: 'key',
      database,
      key,
    }),
    // The key's own text is what the palette shows: no schema prefix.
    nameStart: 0,
  };
}

export function collectionItems(
  connectionId: string,
  connectionName: string,
  database: string,
  collections: readonly DocCollection[],
): ObjectItem[] {
  return collections
    .filter((collection) => !collection.system)
    .map((collection) =>
      familyItem(connectionId, connectionName, database, collection.name, { type: 'collection' }),
    );
}

export function searchItems(
  connectionId: string,
  connectionName: string,
  lists: {
    indices: readonly Named[];
    dataStreams: readonly Named[];
    aliases: readonly Named[];
  },
): ObjectItem[] {
  const named = (list: readonly Named[], type: 'index' | 'dataStream' | 'alias') =>
    list
      .filter((entry) => !entry.system && !entry.name.startsWith('.'))
      .map((entry) => familyItem(connectionId, connectionName, '', entry.name, { type }));
  return [
    ...named(lists.indices, 'index'),
    ...named(lists.dataStreams, 'dataStream'),
    ...named(lists.aliases, 'alias'),
  ];
}
