import type {
  ConnectionDefinition,
  ConnectionStringCopy,
  ConnectionStringFlavor,
  ConnectionStringNote,
  DotnetProvider,
  EfMigration,
  EfMigrations,
  Engine,
  ObjectRef,
  YadbeError,
} from '../bindings';
import type { YadbeClient } from '../client';
import { sqlEntry, type SqlEngine } from '../sqlEngines';

type Commands = YadbeClient['commands'];
type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

/** The EF Core awareness commands the mock implements. */
export type DotnetCommands = Pick<Commands, 'getEfMigrations' | 'copyConnectionString'>;

export interface DotnetDeps {
  session(connectionId: string): { engine: Engine; database: string } | null;
  definition(connectionId: string): ConnectionDefinition | null;
  /** The remembered password of a connection, `null` when there is none. */
  password(connectionId: string): string | null;
  latency(): number;
  logStatement(connectionId: string, sql: string, error?: YadbeError | null): void;
}

const HISTORY_TABLE = '__EFMigrationsHistory';

function ok<T>(data: T): Result<T> {
  return Promise.resolve({ status: 'ok', data });
}

function fail<T>(error: YadbeError): Result<T> {
  return Promise.resolve({ status: 'error', error });
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Migrations ----------------------------------------------------------------------------

/** Mirror of `db::ef::parse_migration_id`. */
export function parseMigrationId(id: string): { timestamp: string | null; name: string } {
  const cut = id.indexOf('_');
  if (cut < 0) return { timestamp: null, name: id };
  const prefix = id.slice(0, cut);
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(prefix);
  if (match) {
    const [, y, mo, d, h, mi, s] = match.map(Number);
    if (
      y !== undefined &&
      y >= 1 &&
      mo !== undefined &&
      mo >= 1 &&
      mo <= 12 &&
      d !== undefined &&
      d >= 1 &&
      d <= 31 &&
      h !== undefined &&
      h < 24 &&
      mi !== undefined &&
      mi < 60 &&
      s !== undefined &&
      s < 60
    ) {
      return {
        timestamp: `${prefix.slice(0, 4)}-${prefix.slice(4, 6)}-${prefix.slice(6, 8)} ${prefix.slice(8, 10)}:${prefix.slice(10, 12)}:${prefix.slice(12, 14)}`,
        name: id.slice(cut + 1),
      };
    }
  }
  return { timestamp: null, name: id };
}

const RECORDED: [string, string][] = [
  ['20230214091200_InitialCreate', '7.0.2'],
  ['20230301154501_AddCustomers', '7.0.3'],
  ['20230419081330_AddOrdersAndItems', '7.0.5'],
  ['20230419102211_OrderStatusIndex', '7.0.5'],
  ['20230907174402_AddProductCategories', '7.0.11'],
  ['20231122120000_SoftDeleteCustomers', '8.0.0'],
  ['20240115093015_AddShipmentTracking', '8.0.1'],
  ['20240115093847_FixShipmentTrackingIndex', '8.0.1'],
  ['20240608141755_AddAuditColumns', '8.0.6'],
  ['20241003101010_SplitAddresses', '8.0.10'],
];

export function mockMigrations(table: ObjectRef): EfMigrations {
  const migrations: EfMigration[] = RECORDED.map(([id, productVersion]) => ({
    id,
    ...parseMigrationId(id),
    productVersion,
  }));
  return { table, migrations, truncated: false };
}

// --- Connection strings --------------------------------------------------------------------

/** Mirror of `db::dotnet::ado_value`. */
export function adoValue(value: string): string {
  const plain = value !== '' && value.trim() === value && !/[;="']/.test(value);
  if (plain) return value;
  const quote = !value.includes('"') ? '"' : !value.includes("'") ? "'" : '"';
  return `${quote}${value.split(quote).join(quote + quote)}${quote}`;
}

/** Mirror of `db::dotnet::csharp_string`. */
export function csharpString(text: string): string {
  let out = '"';
  for (const c of text) {
    if (c === '\\') out += '\\\\';
    else if (c === '"') out += '\\"';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (c.charCodeAt(0) < 0x20) out += `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else out += c;
  }
  return `${out}"`;
}

const PROVIDERS: Record<SqlEngine, DotnetProvider> = {
  postgres: { adoNet: 'Npgsql', efCore: 'Npgsql.EntityFrameworkCore.PostgreSQL' },
  mssql: {
    adoNet: 'Microsoft.Data.SqlClient',
    efCore: 'Microsoft.EntityFrameworkCore.SqlServer',
  },
  mysql: { adoNet: 'MySqlConnector', efCore: 'Pomelo.EntityFrameworkCore.MySql' },
  sqlite: { adoNet: 'Microsoft.Data.Sqlite', efCore: 'Microsoft.EntityFrameworkCore.Sqlite' },
};

type Pairs = [string, string][];

function pairsOf(
  definition: ConnectionDefinition,
  password: string | null,
  notes: ConnectionStringNote[],
): Pairs {
  const pairs: Pairs = [];
  const push = (key: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined && value.trim() !== '') pairs.push([key, value]);
  };
  const withPassword = () => {
    if (password) pairs.push(['Password', password]);
  };
  const { tlsMode, caCertPath: ca } = definition;
  switch (definition.engine) {
    case 'postgres': {
      push('Host', definition.host);
      if (definition.port !== null) pairs.push(['Port', String(definition.port)]);
      push('Database', definition.database);
      push('Username', definition.username);
      withPassword();
      if (tlsMode === 'disable') pairs.push(['SSL Mode', 'Disable']);
      else if (tlsMode === 'prefer') {
        pairs.push(['SSL Mode', 'Prefer'], ['Trust Server Certificate', 'true']);
      } else if (tlsMode === 'require' && !ca) {
        pairs.push(['SSL Mode', 'Require'], ['Trust Server Certificate', 'true']);
      } else if (tlsMode === 'require') {
        pairs.push(['SSL Mode', 'VerifyCA'], ['Root Certificate', ca ?? '']);
      } else {
        pairs.push(['SSL Mode', 'VerifyFull']);
        if (ca) pairs.push(['Root Certificate', ca]);
      }
      if (definition.connectTimeoutSecs !== null) {
        pairs.push(['Timeout', String(definition.connectTimeoutSecs)]);
      }
      let dropped = false;
      for (const option of definition.options) {
        if (option.key === 'application_name') pairs.push(['Application Name', option.value]);
        else dropped = true;
      }
      if (dropped) notes.push('optionsNotExpressed');
      if (definition.readOnly) {
        pairs.push(['Options', '-c default_transaction_read_only=on']);
      }
      return pairs;
    }
    case 'mssql': {
      push(
        'Server',
        definition.port === null ? definition.host : `${definition.host},${definition.port}`,
      );
      push('Database', definition.database);
      push('User Id', definition.username);
      withPassword();
      if (tlsMode === 'disable') pairs.push(['Encrypt', 'False']);
      else if (tlsMode === 'prefer') {
        pairs.push(['Encrypt', 'Optional'], ['TrustServerCertificate', 'True']);
      } else if (tlsMode === 'require') {
        pairs.push(['Encrypt', 'True'], ['TrustServerCertificate', 'True']);
      } else {
        pairs.push(['Encrypt', 'True'], ['TrustServerCertificate', 'False']);
      }
      if (ca) notes.push('certificateNotExpressed');
      if (definition.connectTimeoutSecs !== null) {
        pairs.push(['Connect Timeout', String(definition.connectTimeoutSecs)]);
      }
      for (const option of definition.options) {
        if (/^application ?name$/i.test(option.key)) {
          pairs.push(['Application Name', option.value]);
        } else {
          notes.push('optionsNotExpressed');
          break;
        }
      }
      if (definition.readOnly) notes.push('readOnlyNotExpressed');
      return pairs;
    }
    case 'mysql': {
      push('Server', definition.host);
      if (definition.port !== null) pairs.push(['Port', String(definition.port)]);
      push('Database', definition.database);
      push('User ID', definition.username);
      withPassword();
      if (tlsMode === 'disable') pairs.push(['SSL Mode', 'None']);
      else if (tlsMode === 'prefer') pairs.push(['SSL Mode', 'Preferred']);
      else if (tlsMode === 'require' && !ca) pairs.push(['SSL Mode', 'Required']);
      else if (tlsMode === 'require') pairs.push(['SSL Mode', 'VerifyCA'], ['SSL CA', ca ?? '']);
      else {
        pairs.push(['SSL Mode', 'VerifyFull']);
        if (ca) pairs.push(['SSL CA', ca]);
      }
      if (definition.connectTimeoutSecs !== null) {
        pairs.push(['Connection Timeout', String(definition.connectTimeoutSecs)]);
      }
      if (definition.options.length > 0) notes.push('optionsNotExpressed');
      if (definition.readOnly) notes.push('readOnlyNotExpressed');
      return pairs;
    }
    case 'sqlite': {
      push('Data Source', definition.filePath);
      if (definition.readOnly) pairs.push(['Mode', 'ReadOnly']);
      if (definition.options.length > 0) notes.push('optionsNotExpressed');
      return pairs;
    }
    case 'redis':
    case 'mongodb':
      return pairs;
  }
}

const EF_CALL: Record<SqlEngine, (cs: string) => string> = {
  postgres: (cs) => `UseNpgsql(${cs})`,
  mssql: (cs) => `UseSqlServer(${cs})`,
  mysql: (cs) => `UseMySql(${cs}, ServerVersion.AutoDetect(${cs}))`,
  sqlite: (cs) => `UseSqlite(${cs})`,
};

/** Mirror of `db::dotnet::build`. */
export function buildConnectionString(
  definition: ConnectionDefinition,
  flavor: ConnectionStringFlavor,
  password: string | null,
): ConnectionStringCopy {
  const notes: ConnectionStringNote[] = [];
  if (definition.ssh) notes.push('sshTunnel');
  const pairs = pairsOf(definition, password, notes);
  const includesPassword = pairs.some(([key]) => key === 'Password');
  if (!includesPassword && definition.engine !== 'sqlite') notes.push('passwordLeftOut');
  const ado = pairs.map(([key, value]) => `${key}=${adoValue(value)}`).join(';');
  const text =
    flavor === 'adoNet'
      ? ado
      : `var connectionString = ${csharpString(ado)};\noptions.${sqlEntry(EF_CALL, definition.engine)('connectionString')};`;
  return { text, provider: sqlEntry(PROVIDERS, definition.engine), includesPassword, notes };
}

export function createMockDotnet(deps: DotnetDeps) {
  const commands: DotnetCommands = {
    getEfMigrations: async (_requestId, connectionId, table) => {
      if (!deps.session(connectionId)) {
        return fail({
          code: 'notConnected',
          message: { en: 'The connection is not open.', fr: "La connexion n'est pas ouverte." },
          action: 'reconnect',
          detail: null,
        });
      }
      if (table.name.toLowerCase() !== HISTORY_TABLE.toLowerCase()) {
        return fail({
          code: 'invalidArgument',
          message: {
            en: `"${table.name}" is not an EF Core migrations history table.`,
            fr: `« ${table.name} » n'est pas une table d'historique des migrations EF Core.`,
          },
          action: null,
          detail: null,
        });
      }
      await sleep(deps.latency());
      deps.logStatement(
        connectionId,
        `SELECT "MigrationId", "ProductVersion" FROM "${table.name}" ORDER BY "MigrationId"`,
      );
      return ok(mockMigrations(table));
    },

    copyConnectionString: async (connectionId, flavor, includePassword) => {
      const definition = deps.definition(connectionId);
      if (!definition) {
        return fail({
          code: 'connectionNotFound',
          message: {
            en: 'This connection no longer exists.',
            fr: "Cette connexion n'existe plus.",
          },
          action: null,
          detail: `connection id ${connectionId}`,
        });
      }
      let password: string | null = null;
      if (includePassword) {
        password = deps.password(connectionId);
        if (password === null) {
          return fail({
            code: 'passwordRequired',
            message: {
              en: 'This connection needs a password.',
              fr: 'Cette connexion a besoin d’un mot de passe.',
            },
            action: 'enterPassword',
            detail: null,
          });
        }
      }
      return ok(buildConnectionString(definition, flavor, password));
    },
  };
  return { commands, reset(): void {} };
}

export type MockDotnet = ReturnType<typeof createMockDotnet>;
