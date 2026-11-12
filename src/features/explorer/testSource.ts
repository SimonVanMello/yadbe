import type { Capabilities, YadbeError } from '../../ipc';
import { MOCK_OBJECT_KINDS, type MockDatabase } from '../../ipc/mock/metaCatalog';
import type { Engine } from '../../ipc';
import type { Loadable, MetaSource } from './explorerRows';
import { requestKey, type MetaRequest } from './metaKeys';

/** Tests only: a `MetaSource` over the mock catalog, with requests recorded and failures on demand. */
export function catalogSource(
  engine: Engine,
  databases: MockDatabase[],
  options: {
    /** Requests (by `requestKey`) that never answer. */
    loading?: (request: MetaRequest) => boolean;
    error?: (request: MetaRequest) => YadbeError | undefined;
  } = {},
) {
  const requested: MetaRequest[] = [];
  const answer = <T>(request: MetaRequest, fetch: boolean, read: () => T): Loadable<T> => {
    if (fetch) requested.push(request);
    const error = options.error?.(request);
    if (error) return { state: 'error', error };
    if (options.loading?.(request)) return fetch ? { state: 'loading' } : { state: 'idle' };
    return { state: 'ready', data: read() };
  };
  const schemaOf = (database: string, schema: string | null) =>
    databases
      .find((d) => d.info.name === database)
      ?.schemas.find((s) => (s.info?.name ?? null) === schema);
  const source: MetaSource = {
    databases: (fetch) =>
      answer({ type: 'databases' }, fetch, () => databases.map((database) => database.info)),
    schemas: (database, fetch) =>
      answer({ type: 'schemas', database }, fetch, () =>
        (databases.find((d) => d.info.name === database)?.schemas ?? []).flatMap((s) =>
          s.info ? [s.info] : [],
        ),
      ),
    counts: (database, schema, fetch) =>
      answer({ type: 'counts', database, schema }, fetch, () =>
        (MOCK_OBJECT_KINDS[engine] ?? []).map((kind) => {
          const objects = (schemaOf(database, schema)?.objects ?? []).filter(
            (o) => o.kind === kind,
          );
          return {
            kind,
            count: objects.length,
            systemCount: objects.filter((o) => o.system).length,
          };
        }),
      ),
    objects: (database, schema, kind, fetch) =>
      answer({ type: 'objects', database, schema, kind }, fetch, () =>
        (schemaOf(database, schema)?.objects ?? []).filter((o) => o.kind === kind),
      ),
    table: (table, kind, fetch) =>
      answer({ type: 'table', table, kind }, fetch, () => {
        const details = schemaOf(table.database, table.schema)?.tables.get(table.name);
        if (!details) throw new Error(`no such table ${table.name}`);
        return details;
      }),
  };
  return {
    source,
    requested,
    keys: () => requested.map((r) => JSON.stringify(requestKey('c', r))),
  };
}

export const POSTGRES: Capabilities = {
  usesFile: false,
  defaultPort: 5432,
  supportsTls: true,
  multipleDatabases: true,
  schemas: true,
  nativeCancel: true,
  readOnlySession: true,
  identifierQuoteOpen: '"',
  identifierQuoteClose: '"',
  foldsUnquotedToLower: true,
  parameterStyles: {
    colon: true,
    at: false,
    atDeclaredAreVariables: false,
    dollarName: false,
    dollarNumber: true,
    question: false,
    questionNumber: false,
  },
  explain: true,
  explainAnalyze: true,
};

export const SQLITE: Capabilities = {
  usesFile: true,
  defaultPort: null,
  supportsTls: false,
  multipleDatabases: false,
  schemas: false,
  nativeCancel: false,
  readOnlySession: false,
  identifierQuoteOpen: '"',
  identifierQuoteClose: '"',
  foldsUnquotedToLower: false,
  parameterStyles: {
    colon: true,
    at: true,
    atDeclaredAreVariables: false,
    dollarName: true,
    dollarNumber: false,
    question: true,
    questionNumber: true,
  },
  explain: true,
  explainAnalyze: false,
};

export const MYSQL: Capabilities = {
  ...POSTGRES,
  schemas: false,
};
