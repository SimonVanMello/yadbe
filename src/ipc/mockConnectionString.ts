import type { ConnectionStringFormat, Engine, ParsedConnectionString, TlsMode } from './bindings';

/**
 * A simplified version of the backend parser (`db/connstring.rs`), enough for the mock:
 * common URL, ADO.NET and JDBC shapes. The real rules live in Rust.
 */
export interface MockParsed {
  fields: ParsedConnectionString;
  password: string | null;
}

const SCHEMES: Record<string, Engine> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  mariadb: 'mysql',
  sqlserver: 'mssql',
  mssql: 'mssql',
  sqlite: 'sqlite',
};

const PG_SSL: Record<string, TlsMode> = {
  disable: 'disable',
  allow: 'prefer',
  prefer: 'prefer',
  require: 'require',
  'verify-ca': 'require',
  'verify-full': 'verifyFull',
};

function empty(format: ConnectionStringFormat, engine: Engine | null): ParsedConnectionString {
  return {
    format,
    engine,
    host: null,
    port: null,
    database: null,
    username: null,
    filePath: null,
    tlsMode: null,
    caCertPath: null,
    options: [],
    passwordId: null,
    ignoredKeys: [],
    mongo: null,
  };
}

function port(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function parseUrl(input: string, format: ConnectionStringFormat): MockParsed | null {
  const scheme = /^([a-z]+):/i.exec(input)?.[1]?.toLowerCase() ?? '';
  const engine = SCHEMES[scheme];
  if (engine === undefined) return null;
  if (engine === 'sqlite') {
    const path = input.slice(scheme.length + 1).replace(/^\/\/(?=\/)/, '');
    return { fields: { ...empty(format, engine), filePath: path }, password: null };
  }
  if (engine === 'mssql' && input.includes(';')) return parseSqlServerUrl(input, format);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const fields = empty(format, engine);
  fields.host = url.hostname ? decodeURIComponent(url.hostname) : null;
  fields.port = url.port ? port(url.port) : null;
  const db = decodeURIComponent(url.pathname.replace(/^\//, ''));
  fields.database = db || null;
  fields.username = url.username ? decodeURIComponent(url.username) : null;
  let password = url.password ? decodeURIComponent(url.password) : null;
  url.searchParams.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === 'sslmode') fields.tlsMode = PG_SSL[value.toLowerCase()] ?? null;
    else if (k === 'sslrootcert') fields.caCertPath = value;
    else if (k === 'user') fields.username = value;
    else if (k === 'password') password = value;
    else if (k === 'application_name') fields.options.push({ key, value });
    else fields.ignoredKeys.push(key);
  });
  return { fields, password };
}

function parseSqlServerUrl(input: string, format: ConnectionStringFormat): MockParsed {
  const [head = '', ...props] = input.replace(/^[a-z]+:\/\//i, '').split(';');
  const [host = '', portText] = head.split(':');
  const fields = empty(format, 'mssql');
  fields.host = host || null;
  fields.port = portText ? port(portText) : null;
  let password: string | null = null;
  for (const prop of props) {
    const [key = '', ...rest] = prop.split('=');
    const value = rest.join('=');
    const k = key.trim().toLowerCase();
    if (!k) continue;
    if (k === 'database' || k === 'databasename') fields.database = value;
    else if (k === 'user' || k === 'username') fields.username = value;
    else if (k === 'password') password = value;
    else fields.ignoredKeys.push(key.trim());
  }
  return { fields, password };
}

function parseAdoNet(input: string, hint: Engine | null): MockParsed {
  const pairs = input
    .split(';')
    .map((part) => part.split('='))
    .filter(([key]) => key?.trim())
    .map(([key = '', ...rest]) => [key.trim().toLowerCase(), rest.join('=').trim()] as const);
  const keys = new Set(pairs.map(([key]) => key));
  const engine: Engine =
    hint ??
    (keys.has('host') || keys.has('username')
      ? 'postgres'
      : keys.has('uid') || keys.has('pwd')
        ? 'mysql'
        : 'mssql');
  const fields = empty('adoNet', engine);
  let password: string | null = null;
  for (const [key, value] of pairs) {
    if (['server', 'host', 'data source', 'address'].includes(key)) {
      const [host = '', portText] = value.replace(/^tcp:/i, '').split(/[,:]/);
      fields.host = host;
      if (portText) fields.port = port(portText);
    } else if (key === 'port') fields.port = port(value);
    else if (['database', 'initial catalog'].includes(key)) fields.database = value;
    else if (['user id', 'uid', 'user', 'username'].includes(key)) fields.username = value;
    else if (['password', 'pwd'].includes(key)) password = value;
    else fields.ignoredKeys.push(key);
  }
  return { fields, password };
}

/** `mongodb://` and `mongodb+srv://` (mirror of `document::settings::parse_uri`). */
function parseMongo(input: string): MockParsed | null {
  const match = /^mongodb(\+srv)?:\/\/(?:([^@/]*)@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/i.exec(
    input,
  );
  if (!match) return null;
  const [, srv, userinfo, hosts = '', database, query = ''] = match;
  const fields = empty('url', 'mongodb');
  const [user = '', pass = ''] = (userinfo ?? '').split(':');
  const seeds = decodeURIComponent(hosts);
  // One host with its port fills host and port; a seed list stays whole in the host field.
  const single = srv ? null : /^(\[[^\]]+\]|[^,:[\]]+):(\d+)$/.exec(seeds);
  fields.host = single?.[1] ?? seeds;
  fields.port = single?.[2] ? Number(single[2]) : null;
  fields.database = database ? decodeURIComponent(database) : null;
  fields.username = user ? decodeURIComponent(user) : null;
  // MongoDB's default: TLS only for `mongodb+srv://` or when the string asks for it.
  fields.tlsMode = srv ? 'verifyFull' : 'disable';
  const mongo = {
    srv: Boolean(srv),
    replicaSet: null as string | null,
    authSource: null as string | null,
    authMechanism: 'default' as const,
    directConnection: false,
  };
  for (const [key, value] of new URLSearchParams(query)) {
    const k = key.toLowerCase();
    if (k === 'replicaset') mongo.replicaSet = value;
    else if (k === 'authsource') mongo.authSource = value;
    else if (k === 'directconnection') mongo.directConnection = value === 'true';
    else if (k === 'tls' || k === 'ssl')
      fields.tlsMode = value === 'true' ? 'verifyFull' : 'disable';
    else if ((k === 'tlsinsecure' || k === 'tlsallowinvalidcertificates') && value === 'true')
      fields.tlsMode = 'require';
    else fields.options.push({ key, value });
  }
  fields.mongo = mongo;
  return { fields, password: pass ? decodeURIComponent(pass) : null };
}

export function mockParseConnectionString(input: string, hint: Engine | null): MockParsed | null {
  const text = input.trim();
  if (/^mongodb(\+srv)?:\/\//i.test(text)) return parseMongo(text);
  if (/^jdbc:/i.test(text)) return parseUrl(text.slice(5), 'jdbc');
  if (/^[a-z]+:/i.test(text) && !text.includes('=')) return parseUrl(text, 'url');
  if (/^[a-z]+:\/\//i.test(text)) return parseUrl(text, 'url');
  if (text.includes('=')) return parseAdoNet(text, hint);
  return null;
}
