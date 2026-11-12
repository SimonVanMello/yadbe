import { queryClient } from '../../app/queryClient';
import { useTabsStore } from '../../app/tabs/tabsStore';
import {
  ipc,
  unwrap,
  type DocCollection,
  type DocDatabase,
  type FieldSample,
  type KvCommandHint,
  type SearchAlias,
  type SearchDataStream,
  type SearchIndexDetails,
  type SearchIndexInfo,
} from '../../ipc';
import { fetchMeta } from '../explorer/metaApi';
import { requestKey, type MetaRequest } from '../explorer/metaKeys';
import { findConnection } from '../query/connectionLookup';
import { getQueryTabState } from '../query/queryTabStore';
import type { ConsoleProvider } from './consoleCompletion';
import { mongoshContext, mongoshOptions, type MongoshData } from './mongoshCompletion';
import { redisContext, redisOptions } from './redisCompletion';
import { searchContext, searchOptions, type SearchData } from './searchCompletion';

/**
 * Feeds the pure completion of each console with the metadata the explorer holds: the explorer's
 * own queries (same keys), read from the cache. What is missing is asked once, shared with the
 * explorer's request, and kept; a read that failed is not asked again for a while. Nothing is
 * read per keystroke.
 */

const RETRY_AFTER_MS = 30_000;
const failed = new Map<string, number>();

/** The data of `request` from the cache, read once when it is missing; `null` when unavailable. */
async function ensure<T>(connectionId: string, request: MetaRequest): Promise<T | null> {
  const queryKey = requestKey(connectionId, request);
  const cached = queryClient.getQueryData<T>(queryKey);
  if (cached !== undefined) return cached;
  const memo = JSON.stringify(queryKey);
  const lastFailure = failed.get(memo);
  if (lastFailure !== undefined && Date.now() - lastFailure < RETRY_AFTER_MS) return null;
  try {
    return await queryClient.query<T>({
      queryKey,
      // The explorer reads the same key with the same request, so the data is a `T`.
      queryFn: async ({ signal }) => (await fetchMeta(connectionId, request, signal)) as T,
      staleTime: Infinity,
    });
  } catch {
    failed.set(memo, Date.now());
    return null;
  }
}

/** The connection a console tab runs on, and the database it is aimed at. */
function targetOf(tabId: string): { connectionId: string; database: string } | null {
  const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
  if (!tab?.connectionId) return null;
  const connection = findConnection(tab.connectionId);
  const database = getQueryTabState(tabId).database ?? connection?.database ?? '';
  return { connectionId: tab.connectionId, database };
}

/** mongosh: collections, methods, fields of the collection the call works on. */
export function mongoshProvider(tabId: string): ConsoleProvider {
  return async (text, position, explicit) => {
    const target = targetOf(tabId);
    const context = mongoshContext(text, position);
    if (!target || context.kind === 'none') return null;
    if (context.kind === 'global' && context.prefix === '' && !explicit) return null;
    const { connectionId, database } = target;
    const collections =
      context.kind === 'db' || context.kind === 'collectionName'
        ? ((await ensure<DocCollection[]>(connectionId, { type: 'docCollections', database })) ??
          [])
        : [];
    const databases =
      context.kind === 'use' || context.kind === 'databaseName'
        ? ((await ensure<DocDatabase[]>(connectionId, { type: 'docDatabases' })) ?? [])
        : [];
    let fieldCollection: string | null = null;
    let sample: FieldSample | null = null;
    if (context.kind === 'field' && context.collection !== null) {
      fieldCollection = context.collection;
      sample = await ensure<FieldSample>(connectionId, {
        type: 'docFields',
        database,
        collection: context.collection,
      });
    }
    const data: MongoshData = {
      collections: collections.filter((c) => !c.system).map((c) => c.name),
      databases: databases.map((d) => d.name),
      fields: (collection) =>
        collection === fieldCollection && sample ? sample.fields.map((f) => f.path) : null,
    };
    return mongoshOptions(context, data, position);
  };
}

/** The search console: names of the cluster in the path, fields of the index in the body. */
export function searchProvider(tabId: string): ConsoleProvider {
  return async (text, position, explicit) => {
    const target = targetOf(tabId);
    const context = searchContext(text, position);
    if (!target || context.kind === 'none') return null;
    if (context.kind === 'method' && context.prefix === '' && !explicit) return null;
    const { connectionId } = target;
    let targets: string[] = [];
    if (context.kind === 'path') {
      const [indices, streams, aliases] = await Promise.all([
        ensure<SearchIndexInfo[]>(connectionId, { type: 'searchIndices' }),
        ensure<SearchDataStream[]>(connectionId, { type: 'searchDataStreams' }),
        ensure<SearchAlias[]>(connectionId, { type: 'searchAliases' }),
      ]);
      targets = [...(indices ?? []), ...(streams ?? []), ...(aliases ?? [])]
        .filter((entry) => !entry.system && !entry.name.startsWith('.'))
        .map((entry) => entry.name);
    }
    let details: SearchIndexDetails | null = null;
    const index = context.kind === 'key' || context.kind === 'fieldValue' ? context.target : null;
    // A pattern or a list of indices has no single mapping to read.
    if (index !== null && !/[*,]/.test(index)) {
      details = await ensure<SearchIndexDetails>(connectionId, {
        type: 'searchDetails',
        target: index,
      });
    }
    const data: SearchData = {
      targets,
      fields: (name) => (name === index && details ? details.fields : null),
    };
    return searchOptions(context, data, position);
  };
}

/** Redis: the commands the server lists, then the keys already scanned. */
export function redisProvider(tabId: string): ConsoleProvider {
  return async (text, position) => {
    const target = targetOf(tabId);
    const context = redisContext(text, position);
    if (!target || context.kind === 'none') return null;
    const { connectionId, database } = target;
    if (context.kind === 'command') {
      const commands = await queryClient
        .query({
          queryKey: ['kvCommandHints', connectionId],
          queryFn: () => unwrap(ipc.commands.kvCommandHints(connectionId)),
          staleTime: Infinity,
        })
        .catch((): KvCommandHint[] => []);
      return redisOptions(context, { commands, keys: [] }, position);
    }
    // The backend's index of the scanned keys: local, no round trip to the server.
    const found = await unwrap(
      ipc.commands.kvFindKeys(connectionId, Number.parseInt(database, 10) || 0, context.prefix, 30),
    ).catch(() => null);
    return redisOptions(
      context,
      { commands: [], keys: found?.keys.map((key) => key.text) ?? [] },
      position,
    );
  };
}
