import type {
  ConnectionDefinition,
  ConnectionGroup,
  Engine,
  EngineInfo,
  SavedConnection,
} from './bindings';

/** Fixed timestamps keep captures and tests deterministic (Unix seconds). */
const CREATED_AT = 1_762_000_000;

export const MOCK_ENGINES: EngineInfo[] = [
  {
    engine: 'postgres',
    label: 'PostgreSQL',
    capabilities: {
      usesFile: false,
      defaultPort: 5432,
      supportsTls: true,
      multipleDatabases: true,
      schemas: true,
      nativeCancel: true,
      readOnlySession: true,
    },
    defaultUsername: 'postgres',
    available: true,
  },
  {
    engine: 'mssql',
    label: 'SQL Server',
    capabilities: {
      usesFile: false,
      defaultPort: 1433,
      supportsTls: true,
      multipleDatabases: true,
      schemas: true,
      nativeCancel: true,
      readOnlySession: false,
    },
    defaultUsername: 'sa',
    available: true,
  },
  {
    engine: 'mysql',
    label: 'MySQL / MariaDB',
    capabilities: {
      usesFile: false,
      defaultPort: 3306,
      supportsTls: true,
      multipleDatabases: true,
      schemas: false,
      nativeCancel: true,
      readOnlySession: true,
    },
    defaultUsername: 'root',
    available: false,
  },
  {
    engine: 'sqlite',
    label: 'SQLite',
    capabilities: {
      usesFile: true,
      defaultPort: null,
      supportsTls: false,
      multipleDatabases: false,
      schemas: false,
      nativeCancel: true,
      readOnlySession: true,
    },
    defaultUsername: null,
    available: true,
  },
];

/** A definition with every field at its neutral value, for building variants. */
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
    options: [],
    groupId: null,
    environment: { kind: 'none', label: null, color: null },
    favorite: false,
    readOnly: false,
    rememberPassword: true,
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
export const MOCK_REMEMBERED_PASSWORDS = ['conn-shop-prod', 'conn-shop-staging', 'conn-local-pg'];

export const MOCK_SERVER_VERSIONS: Record<Engine, string> = {
  postgres: 'PostgreSQL 16.4',
  mssql: 'SQL Server 16.0.4135.4',
  mysql: 'MySQL 8.4.2',
  sqlite: 'SQLite 3.46.0',
};
