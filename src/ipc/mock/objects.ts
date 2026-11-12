import type {
  DdlTarget,
  Dependent,
  Engine,
  ObjectAction,
  ObjectInfo,
  ObjectKind,
  ObjectProperties,
  ObjectRef,
  PinnedObject,
  TableDetails,
  YadbeError,
} from '../bindings';
import type { YadbeClient } from '../client';
import { mockObjectActions } from '../mockData';
import { sqlEntry } from '../sqlEngines';
import { mockQualifiedName, metaErrors, type MockMeta } from './meta';

type Commands = YadbeClient['commands'];
type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

/** The object-tool commands the mock implements. */
export type ObjectCommands = Pick<
  Commands,
  | 'getObjectDdl'
  | 'getObjectProperties'
  | 'planObjectAction'
  | 'runObjectAction'
  | 'listPinnedObjects'
  | 'pinObject'
  | 'unpinObject'
>;

export interface ObjectDeps {
  meta: MockMeta;
  readOnly(connectionId: string): boolean;
  logStatement(connectionId: string, sql: string, error?: YadbeError | null): void;
}

const PINS_KEY = 'yadbe.mock.pins';

function ok<T>(data: T): Result<T> {
  return Promise.resolve({ status: 'ok', data });
}

function fail<T>(error: YadbeError): Result<T> {
  return Promise.resolve({ status: 'error', error });
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function notSupported(en: string, fr: string): YadbeError {
  return { code: 'notSupported', message: { en, fr }, action: null, detail: null };
}

function readOnlyViolation(statement: string): YadbeError {
  return {
    code: 'readOnlyViolation',
    message: {
      en: `This connection is read-only: ${statement} may change data or the schema. Nothing was run.`,
      fr: `Cette connexion est en lecture seule : ${statement} peut modifier des données ou le schéma. Rien n'a été exécuté.`,
    },
    action: 'editConnection',
    detail: null,
  };
}

function quoteFor(engine: Engine): (ident: string) => string {
  const [open, close] =
    engine === 'mssql' ? ['[', ']'] : engine === 'mysql' ? ['`', '`'] : ['"', '"'];
  return (ident) => `${open}${ident.split(close).join(close + close)}${close}`;
}

/** Mirror of `ObjectDialect::ddl_name`: SQL Server names its database too. */
function ddlName(engine: Engine, object: ObjectRef): string {
  const name = mockQualifiedName(engine, object);
  return engine === 'mssql' && object.database
    ? `${quoteFor(engine)(object.database)}.${name}`
    : name;
}

/** Mirror of `db::object_ops::action_statement` (the cases the mock catalog has). */
export function mockActionStatement(
  engine: Engine,
  object: ObjectRef,
  info: ObjectInfo,
  action: ObjectAction,
): string | YadbeError {
  const support = mockObjectActions(engine, [info.kind])[0];
  const quote = quoteFor(engine);
  const name = ddlName(engine, object);
  const signature = info.detail.type === 'routine' ? `(${info.detail.identityArguments})` : '';
  switch (action.type) {
    case 'drop': {
      if (!support?.drop)
        return notSupported('Cannot drop this object.', 'Impossible de supprimer cet objet.');
      const word: Record<ObjectKind, string> = {
        table: 'TABLE',
        view: 'VIEW',
        materializedView: engine === 'mssql' ? 'VIEW' : 'MATERIALIZED VIEW',
        function: 'FUNCTION',
        procedure: 'PROCEDURE',
        sequence: 'SEQUENCE',
        type: 'TYPE',
      };
      return `DROP ${word[info.kind]} ${name}${engine === 'postgres' ? signature : ''}`;
    }
    case 'truncate':
      if (!support?.truncate) {
        return notSupported('Cannot truncate this object.', 'Impossible de vider cet objet.');
      }
      return engine === 'sqlite' ? `DELETE FROM ${name}` : `TRUNCATE TABLE ${name}`;
    case 'rename': {
      if (!support?.rename) {
        return notSupported('Cannot rename this object.', 'Impossible de renommer cet objet.');
      }
      const problem = checkNewName(object.name, action.newName);
      if (problem) return problem;
      switch (engine) {
        case 'postgres': {
          const word: Record<ObjectKind, string> = {
            table: 'TABLE',
            view: 'VIEW',
            materializedView: 'MATERIALIZED VIEW',
            function: 'FUNCTION',
            procedure: 'PROCEDURE',
            sequence: 'SEQUENCE',
            type: 'TYPE',
          };
          return `ALTER ${word[info.kind]} ${name}${signature} RENAME TO ${quote(action.newName)}`;
        }
        case 'mssql': {
          const old = `${object.schema === null ? '' : `${quote(object.schema)}.`}${quote(object.name)}`;
          return `EXEC ${quote(object.database)}.sys.sp_rename N'${old.replaceAll("'", "''")}', N'${action.newName.replaceAll("'", "''")}'`;
        }
        case 'mysql':
          return `RENAME TABLE ${name} TO ${ddlName(engine, { ...object, name: action.newName })}`;
        case 'sqlite':
        case 'mongodb':
          return `ALTER TABLE ${name} RENAME TO ${quote(action.newName)}`;
        case 'redis':
          return notSupported('Cannot rename this object.', 'Impossible de renommer cet objet.');
      }
    }
  }
}

function checkNewName(old: string, next: string): YadbeError | null {
  const bad = (en: string, fr: string): YadbeError => ({
    code: 'invalidArgument',
    message: { en, fr },
    action: null,
    detail: null,
  });
  if (next.trim() === '') return bad('The new name is empty.', 'Le nouveau nom est vide.');
  if (next === old) {
    return bad('The new name is the current one.', 'Le nouveau nom est le nom actuel.');
  }
  if (Array.from(next).length > 128) {
    return bad(
      'The new name is longer than 128 characters.',
      'Le nouveau nom dépasse 128 caractères.',
    );
  }
  return null;
}

function reconstructedHeader(engine: Engine, what: string): string {
  const label = sqlEntry(
    { postgres: 'PostgreSQL', mssql: 'SQL Server', mysql: 'MySQL', sqlite: 'SQLite' },
    engine,
  );
  return `-- Reconstructed by yadbe from the catalog: ${label} keeps no definition text for ${what}.\n`;
}

function tableText(engine: Engine, details: TableDetails): string {
  const quote = quoteFor(engine);
  const lines = details.columns.map((c) => {
    let line = `  ${quote(c.name)} ${c.typeName}`;
    if (c.identity !== null) line += ' GENERATED ALWAYS AS IDENTITY';
    if (c.default !== null) line += ` DEFAULT ${c.default}`;
    if (!c.nullable) line += ' NOT NULL';
    return line;
  });
  const columns = (names: string[]) => names.map(quote).join(', ');
  if (details.primaryKey) {
    lines.push(`  PRIMARY KEY (${columns(details.primaryKey.columns)})`);
  }
  for (const key of details.uniqueKeys) lines.push(`  UNIQUE (${columns(key.columns)})`);
  for (const fk of details.foreignKeys) {
    lines.push(
      `  FOREIGN KEY (${columns(fk.columns)}) REFERENCES ${ddlName(engine, fk.referencedTable)} (${columns(fk.referencedColumns)})`,
    );
  }
  for (const check of details.checks) lines.push(`  CHECK (${check.expression})`);
  let text = `CREATE TABLE ${ddlName(engine, details.table)} (\n${lines.join(',\n')}\n);\n`;
  for (const index of details.indexes) {
    if (index.primary) continue;
    text += `\nCREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quote(index.name)} ON ${ddlName(engine, details.table)} (${index.columns.join(', ')})${index.predicate ? ` WHERE ${index.predicate}` : ''};\n`;
  }
  for (const trigger of details.triggers) {
    text += `\nCREATE TRIGGER ${quote(trigger.name)} ${trigger.timing.toUpperCase()} ${trigger.events.join(' OR ').toUpperCase()} ON ${ddlName(engine, details.table)}\n  FOR EACH ROW EXECUTE FUNCTION touch();\n`;
  }
  return text;
}

function ddlOf(
  engine: Engine,
  object: ObjectRef,
  info: ObjectInfo,
  details: TableDetails | null,
): { sql: string; source: 'catalog' | 'reconstructed' } {
  const name = ddlName(engine, object);
  switch (info.kind) {
    case 'table':
      if (!details) break;
      if (engine === 'postgres' || engine === 'mssql') {
        return {
          sql: reconstructedHeader(engine, 'a table') + tableText(engine, details),
          source: 'reconstructed',
        };
      }
      return { sql: tableText(engine, details), source: 'catalog' };
    case 'view':
    case 'materializedView': {
      const columns = (details?.columns ?? []).map((c) => `  ${c.name}`).join(',\n');
      const word = info.kind === 'view' ? 'VIEW' : 'MATERIALIZED VIEW';
      return {
        sql: `CREATE ${word} ${name} AS\nSELECT\n${columns || '  1'}\nFROM ${name.replace(/_view$|_summary$/, '')};\n`,
        source: 'catalog',
      };
    }
    case 'function':
    case 'procedure': {
      if (info.detail.type !== 'routine') break;
      const word = info.kind === 'function' ? 'FUNCTION' : 'PROCEDURE';
      const returns = info.detail.returnType ? `\nRETURNS ${info.detail.returnType}` : '';
      return {
        sql: `CREATE OR REPLACE ${word} ${name}(${info.detail.arguments})${returns}\nLANGUAGE ${info.detail.language ?? 'sql'}\nAS $$\n  SELECT 1;\n$$;\n`,
        source: 'catalog',
      };
    }
    case 'sequence': {
      if (info.detail.type !== 'sequence') break;
      const s = info.detail;
      return {
        sql: `${reconstructedHeader(engine, 'a sequence')}CREATE SEQUENCE ${name}\n  AS ${s.dataType}\n  START WITH ${s.start}\n  INCREMENT BY ${s.increment}\n  MINVALUE ${s.min}\n  MAXVALUE ${s.max}\n  ${s.cycle ? 'CYCLE' : 'NO CYCLE'};\n`,
        source: 'reconstructed',
      };
    }
    case 'type': {
      if (info.detail.type !== 'type') break;
      const t = info.detail;
      const body =
        t.category === 'enum'
          ? `CREATE TYPE ${name} AS ENUM (${t.enumValues.map((v) => `'${v.replaceAll("'", "''")}'`).join(', ')});\n`
          : t.category === 'domain'
            ? `CREATE DOMAIN ${name} AS ${t.baseType ?? 'text'};\n`
            : `CREATE TYPE ${name} AS (\n${t.attributes.map((a) => `  ${a.name} ${a.typeName}`).join(',\n')}\n);\n`;
      return { sql: reconstructedHeader(engine, 'a type') + body, source: 'reconstructed' };
    }
  }
  return { sql: `-- No definition for ${name}.\n`, source: 'reconstructed' };
}

/** A believable date, stable between runs. */
const STAMP = '2025-11-04 09:12:45';

function propertiesOf(
  engine: Engine,
  object: ObjectRef,
  kind: ObjectKind,
  info: ObjectInfo,
  details: TableDetails,
  owner: string | null,
): ObjectProperties {
  const rows = details.rowEstimate;
  const dataBytes = rows === null || kind === 'view' ? null : Math.round(rows * 96);
  const indexBytes = dataBytes === null ? null : Math.round(dataBytes * 0.35);
  return {
    object,
    kind,
    owner: engine === 'sqlite' || engine === 'mysql' ? null : owner,
    comment: info.comment,
    rowEstimate: rows,
    dataBytes,
    indexBytes,
    totalBytes: dataBytes === null || indexBytes === null ? null : dataBytes + indexBytes,
    created: engine === 'mssql' || engine === 'mysql' ? '2024-03-18 14:02:10' : null,
    modified: engine === 'mssql' || engine === 'mysql' ? STAMP : null,
    storageEngine: engine === 'mysql' ? 'InnoDB' : null,
    collation: engine === 'mysql' ? 'utf8mb4_0900_ai_ci' : null,
    lastAnalyzed: engine === 'postgres' && kind === 'table' ? STAMP : null,
    lastVacuumed: engine === 'postgres' && kind === 'table' ? '2025-11-03 03:00:12' : null,
  };
}

/** Drop, truncate, rename, properties, DDL and pins of the mock backend. */
export function createMockObjects(deps: ObjectDeps) {
  let pins: PinnedObject[] = [];

  function persist(): void {
    try {
      sessionStorage.setItem(PINS_KEY, JSON.stringify(pins));
    } catch {
      // Storage unavailable: the pins then last as long as the page.
    }
  }

  function restore(): void {
    try {
      const raw = sessionStorage.getItem(PINS_KEY);
      if (raw) pins = JSON.parse(raw) as PinnedObject[];
    } catch {
      // Unreadable: start without pins.
    }
  }

  const samePin = (a: PinnedObject, b: PinnedObject) =>
    a.connectionId === b.connectionId &&
    a.database === b.database &&
    a.schema === b.schema &&
    a.kind === b.kind &&
    a.id === b.id;

  function dependents(
    engine: Engine,
    connectionId: string,
    object: ObjectRef,
    kind: ObjectKind,
  ): { complete: boolean; items: Dependent[] } {
    const items: Dependent[] = [];
    if (kind === 'table') {
      const found = deps.meta.tablesOf(connectionId, object.database) ?? [];
      for (const other of found) {
        for (const fk of other.foreignKeys) {
          const target = fk.referencedTable;
          if (target.schema === object.schema && target.name === object.name) {
            if (other.table.schema === object.schema && other.table.name === object.name) continue;
            items.push({
              kind: 'table',
              object: other.table,
              via: { type: 'foreignKey', name: fk.name ?? fk.columns.join(', ') },
            });
          }
        }
      }
    }
    return { complete: engine !== 'sqlite', items };
  }

  const commands: ObjectCommands = {
    getObjectDdl: async (_requestId, connectionId, target: DdlTarget) => {
      await sleep(deps.meta.latency());
      const object = target.type === 'object' ? target.object : target.table;
      const kind = target.type === 'object' ? target.kind : 'table';
      const id = target.type === 'object' ? target.id : object.name;
      const found = deps.meta.lookup(connectionId, object, kind, id);
      if (!found) return fail(metaErrors.objectNotFound(object.name));
      if (target.type === 'object') {
        return ok(ddlOf(found.engine, target.object, found.info, found.details));
      }
      const details = found.details;
      if (!details) return fail(metaErrors.objectNotFound(object.name));
      const quote = quoteFor(found.engine);
      if (target.type === 'trigger') {
        const trigger = details.triggers.find((t) => t.name === target.name);
        if (!trigger) return fail(metaErrors.objectNotFound(target.name));
        return ok({
          sql: `CREATE TRIGGER ${quote(trigger.name)} ${trigger.timing.toUpperCase()} ${trigger.events.join(' OR ').toUpperCase()} ON ${ddlName(found.engine, object)}\n  FOR EACH ROW EXECUTE FUNCTION touch();\n`,
          source: 'catalog',
        });
      }
      const index = details.indexes.find((i) => i.name === target.name);
      if (!index) return fail(metaErrors.objectNotFound(target.name));
      return ok({
        sql: `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quote(index.name)} ON ${ddlName(found.engine, object)} (${index.columns.join(', ')})${index.predicate ? ` WHERE ${index.predicate}` : ''};\n`,
        source: 'catalog',
      });
    },

    getObjectProperties: async (_requestId, connectionId, object, kind) => {
      await sleep(deps.meta.latency());
      const found = deps.meta.lookup(connectionId, object, kind, object.name);
      if (!found?.details) return fail(metaErrors.objectNotFound(object.name));
      return ok(
        propertiesOf(
          found.engine,
          object,
          kind,
          found.info,
          found.details,
          found.schema.info?.owner ?? null,
        ),
      );
    },

    planObjectAction: async (_requestId, connectionId, request) => {
      await sleep(deps.meta.latency());
      const found = deps.meta.lookup(connectionId, request.object, request.kind, request.id);
      if (!found) return fail(metaErrors.objectNotFound(request.object.name));
      const sql = mockActionStatement(found.engine, request.object, found.info, request.action);
      if (typeof sql !== 'string') return fail(sql);
      return ok({
        sql,
        rowEstimate: found.details?.rowEstimate ?? null,
        dependents: dependents(found.engine, connectionId, request.object, request.kind),
      });
    },

    runObjectAction: async (_requestId, connectionId, request) => {
      if (deps.readOnly(connectionId)) {
        const word = { drop: 'DROP', truncate: 'TRUNCATE', rename: 'RENAME' }[request.action.type];
        return fail(readOnlyViolation(word));
      }
      await sleep(deps.meta.latency());
      const found = deps.meta.lookup(connectionId, request.object, request.kind, request.id);
      if (!found) return fail(metaErrors.objectNotFound(request.object.name));
      const sql = mockActionStatement(found.engine, request.object, found.info, request.action);
      if (typeof sql !== 'string') return fail(sql);
      deps.logStatement(connectionId, sql);
      const { schema, info } = found;
      if (request.action.type === 'drop') {
        schema.objects = schema.objects.filter((o) => o !== info);
        schema.tables.delete(info.name);
      } else if (request.action.type === 'rename') {
        const { newName } = request.action;
        const details = schema.tables.get(info.name);
        schema.tables.delete(info.name);
        info.name = newName;
        info.id = newName;
        if (details) {
          details.table = { ...details.table, name: newName };
          schema.tables.set(newName, details);
        }
        for (const other of schema.tables.values()) {
          for (const fk of other.foreignKeys) {
            if (
              fk.referencedTable.schema === request.object.schema &&
              fk.referencedTable.name === request.object.name
            ) {
              fk.referencedTable = { ...fk.referencedTable, name: newName };
            }
          }
        }
        pins = pins.map((pin) =>
          pin.connectionId === connectionId &&
          pin.database === request.object.database &&
          pin.schema === request.object.schema &&
          pin.kind === request.kind &&
          pin.id === request.id
            ? { ...pin, name: newName, id: newName }
            : pin,
        );
        persist();
      } else {
        // Truncating empties the rows, which the mock keeps nowhere but in the estimate.
        if (found.details) found.details.rowEstimate = 0;
        if (info.detail.type === 'relation') info.detail.rowEstimate = 0;
      }
      deps.meta.changed(
        connectionId,
        request.kind === 'table' || request.kind === 'view' || request.kind === 'materializedView'
          ? { level: 'schema', database: request.object.database, schema: request.object.schema }
          : {
              level: 'objects',
              database: request.object.database,
              schema: request.object.schema,
              kind: request.kind,
            },
      );
      return ok({
        sql,
        renamedTo:
          request.action.type === 'rename'
            ? { ...request.object, name: request.action.newName }
            : null,
      });
    },

    listPinnedObjects: () => ok(structuredClone(pins)),

    pinObject: (pin) => {
      if (!pins.some((p) => samePin(p, pin))) {
        pins = [...pins, structuredClone(pin)];
        persist();
      }
      return ok(null);
    },

    unpinObject: (pin) => {
      pins = pins.filter((p) => !samePin(p, pin));
      persist();
      return ok(null);
    },
  };

  restore();

  return {
    commands,
    /** The pins of a connection that was deleted go with it. */
    forgetConnection(connectionId: string): void {
      pins = pins.filter((pin) => pin.connectionId !== connectionId);
      persist();
    },
    reset(): void {
      pins = [];
      try {
        sessionStorage.removeItem(PINS_KEY);
      } catch {
        // Nothing to clear.
      }
    },
  };
}

export type MockObjects = ReturnType<typeof createMockObjects>;
