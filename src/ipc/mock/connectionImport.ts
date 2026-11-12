import type {
  ConnectionConflict,
  ConnectionDefinition,
  ConnectionGroup,
  ConnectionImportResult,
  ConnectionScan,
  ConnectionSourceInfo,
  ConnectionSourceKind,
  FoundConnection,
  SavedConnection,
  SkippedEntry,
  YadbeError,
} from '../bindings';
import type { YadbeCommands } from '../client';
import { blankDefinition } from '../mockData';
import { mockErrors } from '../mockErrors';

type ConnectionImportCommands = Pick<
  YadbeCommands,
  'listConnectionSources' | 'scanConnectionSource' | 'importConnections' | 'exportConnections'
>;

type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

const ok = <T>(data: T): Result<T> => Promise.resolve({ status: 'ok', data });
const fail = <T>(error: YadbeError): Result<T> => Promise.resolve({ status: 'error', error });

const FORMAT = 'yadbe-connections';
const VERSION = 1;

export interface MockConnectionImportHost {
  connections(): SavedConnection[];
  groups(): ConnectionGroup[];
  createGroup(name: string, parentId: string | null): ConnectionGroup;
  createConnection(definition: ConnectionDefinition): SavedConnection | YadbeError;
  /** Keeps a password the way the keychain does; returns where it went. */
  storePassword(connectionId: string, password: string): 'keychain' | 'session';
  readFile(path: string): string | undefined;
  writeFile(path: string, text: string): void;
}

interface Fixture {
  defaultPath: string | null;
  found: FoundConnection[];
  skipped: SkippedEntry[];
  /** Passwords the source file holds, by key (a `.pgpass`). */
  passwords: Record<string, string>;
}

function found(
  key: string,
  definition: ConnectionDefinition,
  groupPath: string[] = [],
  notes: FoundConnection['notes'] = [],
  hasPassword = false,
): FoundConnection {
  return { key, definition, groupPath, hasPassword, conflict: null, notes };
}

const note = (kind: FoundConnection['notes'][number]['kind']) => ({ kind, detail: null });

/** What each source "finds" on the mock computer. */
const FIXTURES: Record<ConnectionSourceKind, Fixture> = {
  azureDataStudio: {
    defaultPath: '/home/ana/.config/azuredatastudio/User/settings.json',
    found: [
      found(
        'ads-1',
        {
          ...blankDefinition('mssql', 'Orders (prod)'),
          host: 'sql-eu.example.com',
          port: 1444,
          database: 'orders',
          username: 'app',
          tlsMode: 'verifyFull',
          rememberPassword: false,
        },
        ['Prod', 'EU'],
      ),
      found(
        'ads-2',
        {
          ...blankDefinition('mssql', 'localhost\\SQLEXPRESS'),
          host: 'localhost\\SQLEXPRESS',
          auth: 'none',
          rememberPassword: false,
        },
        [],
        [note('integratedAuth')],
      ),
      found('ads-3', {
        ...blankDefinition('mssql', 'reporting (copy)'),
        host: 'sql.example.com',
        database: 'Reporting',
        username: 'report',
        tlsMode: 'verifyFull',
        rememberPassword: false,
      }),
    ],
    skipped: [{ name: 'Kusto cluster', reason: 'unsupportedEngine', detail: 'KUSTO' }],
    passwords: {},
  },
  vscodeMssql: { defaultPath: null, found: [], skipped: [], passwords: {} },
  ssms: { defaultPath: null, found: [], skipped: [], passwords: {} },
  dbeaver: {
    defaultPath: '/home/ana/.local/share/DBeaverData/workspace6/General/.dbeaver/data-sources.json',
    found: [
      found(
        'dbeaver-1',
        {
          ...blankDefinition('postgres', 'Billing (prod)'),
          host: 'billing.example.com',
          database: 'billing',
          tlsMode: 'verifyFull',
          environment: { kind: 'prod', label: null, color: null },
          readOnly: true,
          rememberPassword: false,
        },
        ['Prod'],
        [note('userMissing')],
      ),
      found(
        'dbeaver-2',
        {
          ...blankDefinition('mysql', 'Local MySQL'),
          host: 'localhost',
          username: 'root',
          environment: { kind: 'dev', label: null, color: null },
          rememberPassword: false,
          ssh: {
            server: {
              host: 'bastion.example.com',
              port: 2222,
              username: 'deploy',
              auth: 'key',
              keyPath: '/home/ana/.ssh/id_ed25519',
              rememberSecret: false,
            },
            jump: null,
            keepaliveSecs: null,
          },
        },
        [],
        [note('passwordNotImported')],
      ),
    ],
    skipped: [{ name: 'Legacy', reason: 'unsupportedEngine', detail: 'oracle_thin' }],
    passwords: {},
  },
  pgpass: {
    defaultPath: '/home/ana/.pgpass',
    found: [
      found(
        'line 1',
        {
          ...blankDefinition('postgres', 'postgres@localhost/app_dev'),
          host: 'localhost',
          database: 'app_dev',
          username: 'postgres',
          rememberPassword: false,
        },
        [],
        [],
        true,
      ),
      found(
        'line 2',
        {
          ...blankDefinition('postgres', 'analyst@warehouse.example.com:5433/dw'),
          host: 'warehouse.example.com',
          port: 5433,
          database: 'dw',
          username: 'analyst',
          tlsMode: 'verifyFull',
          rememberPassword: false,
        },
        [],
        [],
        true,
      ),
    ],
    skipped: [{ name: '*@*:5432/*', reason: 'wildcard', detail: null }],
    passwords: { 'line 1': 'pg-secret', 'line 2': 'dw-secret' },
  },
  pgService: { defaultPath: null, found: [], skipped: [], passwords: {} },
  yadbe: { defaultPath: null, found: [], skipped: [], passwords: {} },
};

function portOf(definition: ConnectionDefinition): number {
  if (definition.port !== null) return definition.port;
  switch (definition.engine) {
    case 'postgres':
      return 5432;
    case 'mssql':
      return 1433;
    case 'mysql':
      return 3306;
    default:
      return 0;
  }
}

function conflictOf(
  definition: ConnectionDefinition,
  existing: SavedConnection[],
): ConnectionConflict | null {
  const same = existing.find((c) => {
    const e = c.definition;
    return (
      e.engine === definition.engine &&
      e.host.toLowerCase() === definition.host.toLowerCase() &&
      portOf(e) === portOf(definition) &&
      e.database.toLowerCase() === definition.database.toLowerCase() &&
      e.username.toLowerCase() === definition.username.toLowerCase() &&
      e.filePath === definition.filePath
    );
  });
  if (same) {
    return { existingId: same.id, existingName: same.definition.name, kind: 'sameTarget' };
  }
  const named = existing.find(
    (c) => c.definition.name.toLowerCase() === definition.name.toLowerCase(),
  );
  return named
    ? { existingId: named.id, existingName: named.definition.name, kind: 'sameName' }
    : null;
}

interface ExportedFile {
  format: string;
  version: number;
  appVersion: string;
  groups: { id: string; name: string; parentId: string | null }[];
  connections: ConnectionDefinition[];
}

function pathOf(
  groups: { id: string; name: string; parentId: string | null }[],
  id: string | null,
) {
  const path: string[] = [];
  let current = id;
  for (let guard = 0; current !== null && guard < 32; guard++) {
    const group = groups.find((g) => g.id === current);
    if (!group) break;
    path.unshift(group.name);
    current = group.parentId;
  }
  return path;
}

/** The connection import and export of the mock backend (`conn_import/`). */
export function createMockConnectionImport(host: MockConnectionImportHost) {
  function load(
    kind: ConnectionSourceKind,
    path: string | null,
  ): { path: string; fixture: Fixture } | YadbeError {
    if (kind === 'yadbe') {
      if (path === null) return mockErrors.fileNotFound('connections.json');
      const text = host.readFile(path);
      if (text === undefined) return mockErrors.fileNotFound(path);
      let file: ExportedFile;
      try {
        file = JSON.parse(text) as ExportedFile;
      } catch {
        file = { format: '', version: 0, appVersion: '', groups: [], connections: [] };
      }
      if (file.format !== FORMAT) {
        return mockErrors.connectionFileInvalid(
          'This file is not a yadbe connections file.',
          "Ce fichier n'est pas un fichier de connexions yadbe.",
        );
      }
      if (file.version > VERSION) {
        return mockErrors.connectionFileInvalid(
          'This file was written by a newer version of yadbe: update yadbe to read it.',
          'Ce fichier a été écrit par une version plus récente de yadbe : mettez yadbe à jour pour le lire.',
        );
      }
      return {
        path,
        fixture: {
          defaultPath: null,
          found: file.connections.map((definition, index) =>
            found(
              `#${index + 1}`,
              { ...definition, groupId: null },
              pathOf(file.groups, definition.groupId),
            ),
          ),
          skipped: [],
          passwords: {},
        },
      };
    }
    const fixture = FIXTURES[kind];
    const chosen = path ?? fixture.defaultPath;
    if (chosen === null) return mockErrors.fileNotFound(`~/${kind}`);
    if (!chosen.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(chosen)) {
      return mockErrors.invalidArgument(
        'The file path must be absolute.',
        'Le chemin du fichier doit être absolu.',
      );
    }
    return { path: chosen, fixture };
  }

  const isError = (value: object): value is YadbeError => 'code' in value && 'message' in value;

  const commands: ConnectionImportCommands = {
    listConnectionSources: () =>
      ok(
        (Object.keys(FIXTURES) as ConnectionSourceKind[]).map((kind): ConnectionSourceInfo => ({
          kind,
          defaultPath: FIXTURES[kind].defaultPath,
          supportsPasswords: kind === 'pgpass',
        })),
      ),

    scanConnectionSource: (kind, path) => {
      const loaded = load(kind, path);
      if (isError(loaded)) return fail(loaded);
      const existing = host.connections();
      const scan: ConnectionScan = {
        kind,
        path: loaded.path,
        connections: structuredClone(loaded.fixture.found).map((c) => ({
          ...c,
          conflict: conflictOf(c.definition, existing),
        })),
        skipped: structuredClone(loaded.fixture.skipped),
      };
      return ok(scan);
    },

    importConnections: (request) => {
      const loaded = load(request.kind, request.path);
      if (isError(loaded)) return fail(loaded);
      const result: ConnectionImportResult = {
        created: [],
        groupsCreated: 0,
        passwordsStored: 0,
        passwordsSessionOnly: 0,
        failed: [],
      };
      const taken = new Set(host.connections().map((c) => c.definition.name.toLowerCase()));
      for (const item of loaded.fixture.found) {
        if (!request.keys.includes(item.key)) continue;
        let parentId: string | null = null;
        for (const name of item.groupPath) {
          const existingGroup = host
            .groups()
            .find((g) => g.parentId === parentId && g.name.toLowerCase() === name.toLowerCase());
          if (existingGroup) parentId = existingGroup.id;
          else {
            parentId = host.createGroup(name, parentId).id;
            result.groupsCreated++;
          }
        }
        let name = item.definition.name;
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${item.definition.name} (${n})`;
        taken.add(name.toLowerCase());
        const password = request.importPasswords ? loaded.fixture.passwords[item.key] : undefined;
        const created = host.createConnection({
          ...item.definition,
          name,
          groupId: parentId,
          rememberPassword: item.definition.rememberPassword || password !== undefined,
        });
        if (isError(created)) {
          result.failed.push({ key: item.key, name, detail: created.message.en });
          continue;
        }
        if (password !== undefined) {
          if (host.storePassword(created.id, password) === 'keychain') result.passwordsStored++;
          else result.passwordsSessionOnly++;
        }
        result.created.push(created);
      }
      return ok(result);
    },

    exportConnections: (path, connectionIds) => {
      const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
      if (!absolute || !/\.json$/i.test(path)) {
        return fail(
          mockErrors.invalidArgument(
            'A connections file is saved at an absolute path ending in .json.',
            'Un fichier de connexions est enregistré à un chemin absolu qui se termine par .json.',
          ),
        );
      }
      const chosen = host
        .connections()
        .filter((c) => connectionIds.length === 0 || connectionIds.includes(c.id));
      const groups: ExportedFile['groups'] = [];
      for (const connection of chosen) {
        let current = connection.definition.groupId;
        while (current !== null) {
          const group = host.groups().find((g) => g.id === current);
          if (!group || groups.some((g) => g.id === group.id)) break;
          groups.push({ id: group.id, name: group.name, parentId: group.parentId });
          current = group.parentId;
        }
      }
      const file: ExportedFile = {
        format: FORMAT,
        version: VERSION,
        appVersion: '0.1.0',
        groups,
        connections: chosen.map((c) => c.definition),
      };
      host.writeFile(path, JSON.stringify(file, null, 2));
      return ok(chosen.length);
    },
  };

  return { commands };
}
