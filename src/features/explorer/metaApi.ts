import { ipc, unwrap, type IpcResult } from '../../ipc';
import type { MetaRequest } from './metaKeys';

let counter = 0;

/**
 * Runs a metadata read that the backend can stop: aborting `signal` (the query lost its last
 * observer, e.g. the node was collapsed while loading) cancels the read on the server.
 */
async function read<T>(signal: AbortSignal, call: (requestId: string) => Promise<IpcResult<T>>) {
  counter += 1;
  const requestId = `explorer-${Date.now().toString(36)}-${counter.toString(36)}`;
  const cancel = () => {
    void ipc.commands.cancelMetaRequest(requestId).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    return await unwrap(call(requestId));
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** The databases of a connection (the same read as the explorer's root, typed). */
export function fetchDatabases(connectionId: string, signal: AbortSignal) {
  return read(signal, (id) => ipc.commands.listDatabases(id, connectionId));
}

/** Reads one node of the explorer. Rejects with a `YadbeIpcError`. */
export function fetchMeta(connectionId: string, request: MetaRequest, signal: AbortSignal) {
  const { commands } = ipc;
  switch (request.type) {
    case 'databases':
      return read(signal, (id) => commands.listDatabases(id, connectionId));
    case 'schemas':
      return read(signal, (id) => commands.listSchemas(id, connectionId, request.database));
    case 'counts':
      return read(signal, (id) =>
        commands.listObjectCounts(id, connectionId, request.database, request.schema),
      );
    case 'objects':
      return read(signal, (id) =>
        commands.listObjects(id, connectionId, request.database, request.schema, request.kind),
      );
    case 'table':
      return read(signal, (id) => commands.getTableDetails(id, connectionId, request.table));
    // The document reads cannot be stopped on the server: an abandoned one is ignored.
    case 'docDatabases':
      return unwrap(commands.mongoListDatabases(connectionId));
    case 'docCollections':
      return unwrap(commands.mongoListCollections(connectionId, request.database));
    case 'docIndexes':
      return unwrap(commands.mongoListIndexes(connectionId, request.database, request.collection));
    case 'docFields':
      return unwrap(
        commands.mongoSampleFields(connectionId, request.database, request.collection, null),
      );
    // Key-value reads: quick, never cancelled on the server (a scan stops by itself).
    case 'kvDatabases':
      return unwrap(commands.kvListDatabases(connectionId));
    case 'kvScan':
      return unwrap(commands.kvScanKeys(connectionId, request.database, request.pattern));
    case 'kvLevel':
      return unwrap(
        commands.kvScanLevel(
          connectionId,
          request.database,
          request.prefix,
          request.delimiter,
          0,
          request.limit,
        ),
      );
    // Search reads: an abandoned one is dropped with its HTTP request when it ends.
    case 'searchIndices':
      return unwrap(commands.searchListIndices(connectionId));
    case 'searchDataStreams':
      return unwrap(commands.searchListDataStreams(connectionId));
    case 'searchAliases':
      return unwrap(commands.searchListAliases(connectionId));
    case 'searchTemplates':
      return unwrap(commands.searchListTemplates(connectionId));
    case 'searchDetails':
      return unwrap(commands.searchIndexDetails(connectionId, request.target));
  }
}

/**
 * Every schema, relation and routine of a database in one read, system objects included (they
 * rank below the user's in the autocomplete; the palette leaves them out): what the palette and
 * the editor's autocomplete search. Rejects with a `YadbeIpcError`.
 */
export function fetchCatalog(connectionId: string, database: string, signal: AbortSignal) {
  return read(signal, (id) => ipc.commands.getCompletionCatalog(id, connectionId, database, true));
}
