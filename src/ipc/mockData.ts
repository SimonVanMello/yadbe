import type {
  ConnectionDefinition,
  ConnectionGroup,
  Engine,
  EngineFamily,
  EngineInfo,
  ObjectActionSupport,
  ObjectKind,
  SavedConnection,
} from './bindings';
import { MOCK_OBJECT_KINDS } from './mock/metaCatalog';

/** Fixed timestamps keep captures and tests deterministic (Unix seconds). */
const CREATED_AT = 1_762_000_000;

/** Mirror of `db::object_ops::support_of`, per engine. */
export function mockObjectActions(
  engine: Engine,
  kinds: readonly ObjectKind[],
): ObjectActionSupport[] {
  return kinds.map((kind) => {
    const table = kind === 'table';
    switch (engine) {
      case 'postgres':
        return { kind, drop: true, truncate: table, rename: true };
      case 'mssql':
        return { kind, drop: true, truncate: table, rename: table || kind === 'sequence' };
      case 'mysql':
        return { kind, drop: true, truncate: table, rename: table || kind === 'view' };
      case 'sqlite':
        return { kind, drop: true, truncate: table, rename: table };
      case 'redis':
        return { kind, drop: false, truncate: false, rename: false };
    }
  });
}

/** What every engine of the SQL family has on top of its own capabilities. */
const SQL_FAMILY = {
  family: 'sql',
  formatter: true,
  ddl: true,
  scriptAs: true,
  dataImport: true,
  efMigrations: true,
  dotnetConnectionString: true,
} as const;

const ENGINES: EngineInfo[] = [
  {
    engine: 'postgres',
    label: 'PostgreSQL',
    capabilities: {
      ...SQL_FAMILY,
      usesFile: false,
      defaultPort: 5432,
      supportsTls: true,
      clientCertificate: true,
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
      activityMonitor: true,
      activityCancelQuery: true,
      tableQualifier: 'schema',
    },
    defaultUsername: 'postgres',
    available: true,
    objectActions: [],
  },
  {
    engine: 'mssql',
    label: 'SQL Server',
    capabilities: {
      ...SQL_FAMILY,
      usesFile: false,
      defaultPort: 1433,
      supportsTls: true,
      clientCertificate: false,
      multipleDatabases: true,
      schemas: true,
      nativeCancel: true,
      readOnlySession: false,
      identifierQuoteOpen: '[',
      identifierQuoteClose: ']',
      foldsUnquotedToLower: false,
      parameterStyles: {
        colon: false,
        at: true,
        atDeclaredAreVariables: true,
        dollarName: false,
        dollarNumber: false,
        question: false,
        questionNumber: false,
      },
      explain: true,
      explainAnalyze: true,
      activityMonitor: true,
      activityCancelQuery: false,
      tableQualifier: 'schema',
    },
    defaultUsername: 'sa',
    available: true,
    objectActions: [],
  },
  {
    engine: 'mysql',
    label: 'MySQL / MariaDB',
    capabilities: {
      ...SQL_FAMILY,
      usesFile: false,
      defaultPort: 3306,
      supportsTls: true,
      clientCertificate: true,
      multipleDatabases: true,
      schemas: false,
      nativeCancel: true,
      readOnlySession: true,
      identifierQuoteOpen: '`',
      identifierQuoteClose: '`',
      foldsUnquotedToLower: false,
      parameterStyles: {
        colon: true,
        at: false,
        atDeclaredAreVariables: false,
        dollarName: false,
        dollarNumber: false,
        question: true,
        questionNumber: false,
      },
      explain: true,
      explainAnalyze: true,
      activityMonitor: true,
      activityCancelQuery: true,
      tableQualifier: 'database',
    },
    defaultUsername: 'root',
    available: true,
    objectActions: [],
  },
  {
    engine: 'sqlite',
    label: 'SQLite',
    capabilities: {
      ...SQL_FAMILY,
      usesFile: true,
      defaultPort: null,
      supportsTls: false,
      clientCertificate: false,
      multipleDatabases: false,
      schemas: false,
      nativeCancel: true,
      readOnlySession: true,
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
      activityMonitor: false,
      activityCancelQuery: false,
      tableQualifier: 'none',
    },
    defaultUsername: null,
    available: true,
    objectActions: [],
  },
  {
    engine: 'redis',
    label: 'Redis / Valkey',
    capabilities: {
      family: 'keyValue',
      usesFile: false,
      defaultPort: 6379,
      supportsTls: true,
      clientCertificate: true,
      multipleDatabases: true,
      schemas: false,
      nativeCancel: false,
      readOnlySession: false,
      identifierQuoteOpen: '"',
      identifierQuoteClose: '"',
      foldsUnquotedToLower: false,
      parameterStyles: {
        colon: false,
        at: false,
        atDeclaredAreVariables: false,
        dollarName: false,
        dollarNumber: false,
        question: false,
        questionNumber: false,
      },
      explain: false,
      explainAnalyze: false,
      activityMonitor: false,
      activityCancelQuery: false,
      tableQualifier: 'database',
      formatter: false,
      ddl: false,
      scriptAs: false,
      dataImport: false,
      efMigrations: false,
      dotnetConnectionString: false,
    },
    defaultUsername: null,
    available: true,
    objectActions: [],
  },
];

export const MOCK_ENGINES: EngineInfo[] = ENGINES.map((info) => ({
  ...info,
  objectActions: mockObjectActions(info.engine, MOCK_OBJECT_KINDS[info.engine] ?? []),
}));

/** A definition with every field at its neutral value, for building variants. */
/** The family the backend derives from an engine (`SavedConnection.family`). */
export function mockFamilyOf(engine: Engine): EngineFamily {
  return MOCK_ENGINES.find((info) => info.engine === engine)?.capabilities.family ?? 'sql';
}

export function blankDefinition(engine: Engine, name = ''): ConnectionDefinition {
  return {
    name,
    engine,
    host: '',
    port: null,
    database: '',
    username: '',
    filePath: '',
    auth: engine === 'sqlite' ? 'none' : 'password',
    tlsMode: 'prefer',
    caCertPath: null,
    connectTimeoutSecs: null,
    statementTimeoutSecs: null,
    keepAliveSecs: null,
    tlsClientCertPath: null,
    tlsClientKeyPath: null,
    options: [],
    groupId: null,
    environment: { kind: 'none', label: null, color: null },
    favorite: false,
    readOnly: false,
    rememberPassword: true,
    historyEnabled: true,
    ssh: null,
  };
}

export const MOCK_GROUPS: ConnectionGroup[] = [
  { id: 'group-clients', name: 'Clients', parentId: null, position: 0, collapsed: false },
  { id: 'group-acme', name: 'ACME', parentId: 'group-clients', position: 0, collapsed: false },
  { id: 'group-local', name: 'Local', parentId: null, position: 1, collapsed: false },
];

function saved(
  id: string,
  position: number,
  definition: ConnectionDefinition,
  lastConnectedAt: number | null = null,
): SavedConnection {
  return {
    id,
    definition,
    family: mockFamilyOf(definition.engine),
    position,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    lastConnectedAt,
  };
}

export const MOCK_CONNECTIONS: SavedConnection[] = [
  saved(
    'conn-shop-prod',
    0,
    {
      ...blankDefinition('postgres', 'shop · prod'),
      host: 'db-eu.example.com',
      database: 'shop',
      username: 'shop_ro',
      tlsMode: 'verifyFull',
      groupId: 'group-acme',
      environment: { kind: 'prod', label: null, color: null },
      favorite: true,
      readOnly: true,
    },
    CREATED_AT + 86_400,
  ),
  saved('conn-shop-staging', 1, {
    ...blankDefinition('postgres', 'shop · staging'),
    host: 'staging.db.example.com',
    port: 6432,
    database: 'shop',
    username: 'shop',
    tlsMode: 'require',
    groupId: 'group-acme',
    environment: { kind: 'staging', label: null, color: null },
  }),
  saved('conn-reporting', 2, {
    ...blankDefinition('mssql', 'reporting'),
    host: 'sql.example.com',
    database: 'Reporting',
    username: 'report',
    tlsMode: 'verifyFull',
    groupId: 'group-acme',
    environment: { kind: 'custom', label: 'QA', color: '#8b5cf6' },
  }),
  saved(
    'conn-local-pg',
    0,
    {
      ...blankDefinition('postgres', 'local postgres'),
      host: 'localhost',
      database: 'app_dev',
      username: 'postgres',
      groupId: 'group-local',
      environment: { kind: 'dev', label: null, color: null },
      favorite: true,
    },
    CREATED_AT + 3600,
  ),
  saved('conn-wordpress', 1, {
    ...blankDefinition('mysql', 'wordpress'),
    host: 'localhost',
    database: 'wordpress',
    username: 'root',
    groupId: 'group-local',
    environment: { kind: 'dev', label: null, color: null },
  }),
  saved('conn-sessions-prod', 3, {
    ...blankDefinition('redis', 'sessions · prod'),
    host: 'redis-eu.example.com',
    port: 6380,
    database: '2',
    username: 'reader',
    tlsMode: 'verifyFull',
    groupId: 'group-acme',
    environment: { kind: 'prod', label: null, color: null },
    readOnly: true,
    keyValue: { keyDelimiter: null },
  }),
  saved('conn-cache', 2, {
    ...blankDefinition('redis', 'cache'),
    host: 'localhost',
    database: '0',
    tlsMode: 'disable',
    groupId: 'group-local',
    environment: { kind: 'dev', label: null, color: null },
    keyValue: { keyDelimiter: null },
  }),
  saved('conn-app-sqlite', 0, {
    ...blankDefinition('sqlite', 'app.sqlite'),
    filePath: '/home/ana/projects/app/app.sqlite',
  }),
  saved('conn-fail-auth', 1, {
    ...blankDefinition('postgres', 'auth failure demo'),
    host: 'fail-auth',
    database: 'shop',
    username: 'intruder',
  }),
];

/** Connections whose password the mock keychain already holds. */
export const MOCK_REMEMBERED_PASSWORDS = [
  'conn-shop-prod',
  'conn-shop-staging',
  'conn-local-pg',
  'conn-wordpress',
  'conn-cache',
  'conn-sessions-prod',
];

export const MOCK_SERVER_VERSIONS: Record<Engine, string> = {
  postgres: 'PostgreSQL 16.4',
  mssql: 'SQL Server 16.0.4135.4',
  mysql: 'MySQL 8.4.2',
  sqlite: 'SQLite 3.46.0',
  redis: 'Redis 8.2.1',
};
