import type {
  DocApplyOutcome,
  DocChangeSet,
  DocConflict,
  DocConflictField,
  DocEdit,
  DocPreview,
  DocPreviewLine,
  DocTopology,
  JournalStatement,
  PathSeg,
  YadbeError,
} from '../bindings';
import type { YadbeClient } from '../client';
import { mockErrors } from '../mockErrors';
import type { Ejson, EjsonDocument, MockCollection } from './documentData';
import type { MockJournal } from './journal';

/**
 * Document edits on the mock MongoDB server (M4-4), mirroring `session::document::edit`: the
 * same checks (each change must find its document as it was read), one transaction on a replica
 * set (all or nothing) and one by one on a standalone server (stop at the first conflict, what
 * ran stays and is journaled), the journal entry and its revert. The preview's guards are a
 * simplified rendering of the backend's.
 */

type Commands = YadbeClient['commands'];
type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;
const ok = <T>(data: T): Result<T> => Promise.resolve({ status: 'ok', data });
const fail = <T>(error: YadbeError): Result<T> => Promise.resolve({ status: 'error', error });

/**
 * A customer whose first apply finds its `email` changed by someone else (a scripted conflict:
 * an edit of that field conflicts, an edit of another field does not).
 */
export const MOCK_STALE_DOCUMENT = {
  database: 'catalog',
  collection: 'customers',
  id: '{"$numberInt":"2"}',
};

export interface MockDocEditHost {
  session(connectionId: string): { readOnly: boolean; topology: DocTopology } | null;
  collection(database: string, name: string): MockCollection | null;
  logStatement(connectionId: string, sql: string, error?: YadbeError | null): void;
  connectionName(connectionId: string): string;
  journal: MockJournal;
}

type Obj = { [key: string]: Ejson };

function isObj(value: Ejson | undefined): value is Obj {
  return (
    value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
  );
}

function isWrapper(value: Ejson | undefined): boolean {
  if (!isObj(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] ?? '').startsWith('$');
}

/** Mirror of `edit::canonical`: plain numbers typed, relaxed dates exact. */
function canonical(value: Ejson): Ejson {
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return Math.abs(value) < 2 ** 31
        ? { $numberInt: String(value) }
        : { $numberLong: String(value) };
    }
    return { $numberDouble: String(value) };
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (isObj(value)) {
    if (isWrapper(value)) {
      const date = value.$date;
      if (typeof date === 'string') return { $date: { $numberLong: String(Date.parse(date)) } };
      return value;
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

const text = (value: Ejson | undefined): string | null =>
  value === undefined ? null : JSON.stringify(canonical(value));

function same(a: Ejson | undefined, b: Ejson | undefined): boolean {
  return text(a) === text(b);
}

function parse(json: string): Ejson {
  return canonical(JSON.parse(json) as Ejson);
}

function valueAt(doc: Ejson | undefined, path: readonly PathSeg[]): Ejson | undefined {
  let current = doc;
  for (const seg of path) {
    if (typeof seg === 'number') current = Array.isArray(current) ? current[seg] : undefined;
    else current = isObj(current) && !isWrapper(current) ? current[seg] : undefined;
  }
  return current;
}

function setAt(doc: Obj, path: readonly PathSeg[], value: Ejson | undefined): void {
  let parent: Ejson = doc;
  for (const seg of path.slice(0, -1)) {
    if (Array.isArray(parent) && typeof seg === 'number') {
      parent = parent[seg] ?? null;
    } else if (isObj(parent) && typeof seg === 'string') {
      if (parent[seg] === undefined) parent[seg] = {};
      parent = parent[seg] ?? null;
    }
  }
  const last = path[path.length - 1];
  if (Array.isArray(parent) && typeof last === 'number') {
    if (value !== undefined) parent[last] = value;
  } else if (isObj(parent) && typeof last === 'string') {
    if (value === undefined) {
      const kept = Object.entries(parent).filter(([k]) => k !== last);
      for (const key of Object.keys(parent)) Reflect.deleteProperty(parent, key);
      Object.assign(parent, Object.fromEntries(kept));
    } else {
      parent[last] = value;
    }
  }
}

function withId(doc: Obj, id: Ejson): Obj {
  return { _id: id, ...Object.fromEntries(Object.entries(doc).filter(([k]) => k !== '_id')) };
}

let counter = 0;
function objectId(): Ejson {
  counter += 1;
  const seconds = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(8, '0');
  return { $oid: `${seconds}00000000${counter.toString(16).padStart(8, '0')}` };
}

// --- mongosh text -----------------------------------------------------------------------------

function shell(value: Ejson | undefined): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(shell).join(', ')}]`;
  if (isObj(value)) {
    const [key, body] = Object.entries(value)[0] ?? [];
    if (isWrapper(value) && typeof body === 'string') {
      switch (key) {
        case '$oid':
          return `ObjectId(${JSON.stringify(body)})`;
        case '$numberInt':
          return `NumberInt(${body})`;
        case '$numberLong':
          return `NumberLong(${JSON.stringify(body)})`;
        case '$numberDecimal':
          return `NumberDecimal(${JSON.stringify(body)})`;
        case '$numberDouble':
          return /\.0$|^-?\d+$/.test(body) ? `Double(${body.replace(/\.0$/, '')})` : body;
      }
    }
    if (key === '$date' && isObj(body) && typeof body.$numberLong === 'string') {
      return `ISODate(${JSON.stringify(new Date(Number(body.$numberLong)).toISOString())})`;
    }
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}: ${shell(v)}`)
      .join(', ')}}`;
  }
  return JSON.stringify(value);
}

const TYPES: Record<string, string> = {
  $numberInt: 'int',
  $numberLong: 'long',
  $numberDouble: 'double',
  $numberDecimal: 'decimal',
  $oid: 'objectId',
  $date: 'date',
};

function typeName(value: Ejson): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'bool';
  if (Array.isArray(value)) return 'array';
  if (isObj(value))
    return isWrapper(value) ? (TYPES[Object.keys(value)[0] ?? ''] ?? 'object') : 'object';
  return 'double';
}

function guard(path: readonly PathSeg[], seen: Ejson | undefined): string[] {
  const expr = path.length === 0 ? '"$$ROOT"' : JSON.stringify(`$${path.map(String).join('.')}`);
  if (seen === undefined) return [`{"$eq": [{"$type": ${expr}}, "missing"]}`];
  const checks = [`{"$eq": [${expr}, {"$literal": ${shell(seen)}}]}`];
  if (path.length > 0)
    checks.push(`{"$eq": [{"$type": ${expr}}, ${JSON.stringify(typeName(seen))}]}`);
  return checks;
}

function filterText(id: Ejson, checks: string[]): string {
  const and = checks.length === 1 ? (checks[0] ?? '') : `{"$and": [${checks.join(', ')}]}`;
  return `{"_id": ${shell(id)}, "$expr": ${and}}`;
}

/** A change made exact, as the backend plans it. */
type Exact =
  | { kind: 'update'; id: Ejson; fields: { path: PathSeg[]; seen?: Ejson; value?: Ejson }[] }
  | { kind: 'replace'; id: Ejson; original: Obj; replacement: Obj }
  | { kind: 'delete'; id: Ejson; original: Obj }
  | { kind: 'insert'; document: Obj };

function exactOf(edit: DocEdit): Exact | YadbeError {
  const invalid = (en: string, fr: string) => mockErrors.invalidArgument(en, fr);
  try {
    switch (edit.kind) {
      case 'update':
        for (const f of edit.fields) {
          if (f.path[0] === '_id') {
            return invalid(
              'The _id of a document cannot be changed: duplicate the document and delete the old one instead.',
              "L'_id d'un document ne peut pas être modifié : dupliquez le document puis supprimez l'ancien.",
            );
          }
        }
        return {
          kind: 'update',
          id: parse(edit.id),
          fields: edit.fields.map((f) => ({
            path: [...f.path],
            ...(f.original === null ? {} : { seen: parse(f.original) }),
            ...(f.value === null ? {} : { value: parse(f.value) }),
          })),
        };
      case 'replace': {
        const id = parse(edit.id);
        const replacement = parse(edit.replacement) as Obj;
        if (replacement._id !== undefined && !same(replacement._id, id)) {
          return invalid(
            'The _id of a document cannot be changed: duplicate the document and delete the old one instead.',
            "L'_id d'un document ne peut pas être modifié : dupliquez le document puis supprimez l'ancien.",
          );
        }
        return {
          kind: 'replace',
          id,
          original: withId(parse(edit.original) as Obj, id),
          replacement: withId(replacement, id),
        };
      }
      case 'delete': {
        const id = parse(edit.id);
        return { kind: 'delete', id, original: withId(parse(edit.original) as Obj, id) };
      }
      case 'insert': {
        const doc = parse(edit.document) as Obj;
        return { kind: 'insert', document: withId(doc, doc._id ?? objectId()) };
      }
    }
  } catch {
    return invalid('This is not valid JSON.', "Ce n'est pas du JSON valide.");
  }
}

function idOf(exact: Exact): Ejson {
  return exact.kind === 'insert' ? (exact.document._id ?? null) : exact.id;
}

function opText(exact: Exact): string {
  switch (exact.kind) {
    case 'update': {
      const checks = exact.fields.flatMap((f) => guard(f.path, f.seen));
      const set = exact.fields.filter((f) => f.value !== undefined);
      const unset = exact.fields.filter((f) => f.value === undefined);
      const parts: string[] = [];
      if (set.length > 0) {
        parts.push(
          `"$set": {${set.map((f) => `${JSON.stringify(f.path.join('.'))}: ${shell(f.value)}`).join(', ')}}`,
        );
      }
      if (unset.length > 0) {
        parts.push(
          `"$unset": {${unset.map((f) => `${JSON.stringify(f.path.join('.'))}: ""`).join(', ')}}`,
        );
      }
      return `coll.updateOne(${filterText(exact.id, checks)}, {${parts.join(', ')}})`;
    }
    case 'replace':
      return `coll.replaceOne(${filterText(exact.id, guard([], exact.original))}, ${shell(exact.replacement)})`;
    case 'delete':
      return `coll.deleteOne(${filterText(exact.id, guard([], exact.original))})`;
    case 'insert':
      return `coll.insertOne(${shell(exact.document)})`;
  }
}

function inverseOf(exact: Exact): DocEdit {
  const t = (value: Ejson) => JSON.stringify(value);
  switch (exact.kind) {
    case 'update':
      return {
        kind: 'update',
        id: t(exact.id),
        fields: exact.fields.map((f) => ({
          path: f.path,
          original: f.value === undefined ? null : t(f.value),
          value: f.seen === undefined ? null : t(f.seen),
        })),
      };
    case 'replace':
      return {
        kind: 'replace',
        id: t(exact.id),
        original: t(exact.replacement),
        replacement: t(exact.original),
      };
    case 'delete':
      return { kind: 'insert', document: t(exact.original) };
    case 'insert':
      return { kind: 'delete', id: t(exact.document._id ?? null), original: t(exact.document) };
  }
}

function find(collection: MockCollection, id: Ejson): number {
  return collection.documents.findIndex((d) => same(d._id, id));
}

/** Why `exact` would not touch exactly its document now, or `null`. */
function check(collection: MockCollection, exact: Exact, index: number): DocConflict | null {
  const at = find(collection, idOf(exact));
  const current = at >= 0 ? (collection.documents[at] as Obj) : undefined;
  const conflict = (kind: DocConflict['kind'], fields: DocConflictField[]): DocConflict => ({
    edit: index,
    kind,
    id: text(idOf(exact)) ?? 'null',
    fields,
    current: current ? text(current) : null,
  });
  if (exact.kind === 'insert') return current ? conflict('exists', []) : null;
  if (!current) return conflict('deleted', []);
  if (exact.kind === 'update') {
    const fields = exact.fields
      .filter((f) => !same(valueAt(current, f.path), f.seen))
      .map((f) => ({
        path: f.path,
        seen: text(f.seen),
        now: text(valueAt(current, f.path)),
        yours: text(f.value),
      }));
    return fields.length > 0 ? conflict('changed', fields) : null;
  }
  if (same(current, exact.original)) return null;
  const names = new Set([...Object.keys(exact.original), ...Object.keys(current)]);
  return conflict(
    'changed',
    [...names]
      .filter((name) => !same(exact.original[name], current[name]))
      .map((name) => ({
        path: [name],
        seen: text(exact.original[name]),
        now: text(current[name]),
        yours: exact.kind === 'replace' ? text(exact.replacement[name]) : null,
      })),
  );
}

function run(collection: MockCollection, exact: Exact): void {
  const at = find(collection, idOf(exact));
  switch (exact.kind) {
    case 'update': {
      const doc = collection.documents[at];
      if (!doc) return;
      for (const f of exact.fields)
        setAt(doc, f.path, f.value === undefined ? undefined : structuredClone(f.value));
      return;
    }
    case 'replace':
      collection.documents[at] = structuredClone<EjsonDocument>(exact.replacement);
      return;
    case 'delete':
      collection.documents.splice(at, 1);
      return;
    case 'insert':
      collection.documents.push(structuredClone<EjsonDocument>(exact.document));
  }
}

export function createMockDocumentEdit(host: MockDocEditHost) {
  let staleDone = false;

  function plan(set: DocChangeSet): { collection: MockCollection; exact: Exact[] } | YadbeError {
    const collection = host.collection(set.database, set.collection);
    if (!collection) return mockErrors.objectNotFound(`${set.database}.${set.collection}`);
    const exact: Exact[] = [];
    for (const edit of set.edits) {
      const one = exactOf(edit);
      if ('code' in one) return one;
      exact.push(one);
    }
    if (exact.length === 0) {
      return mockErrors.invalidArgument('There is nothing to apply.', "Il n'y a rien à appliquer.");
    }
    return { collection, exact };
  }

  function preview(set: DocChangeSet, topology: DocTopology, exact: Exact[]): DocPreview {
    const atomic = topology !== 'standalone';
    const control = (t: string): DocPreviewLine => ({ text: t, role: 'control', edit: null });
    const names = `getDatabase(${JSON.stringify(set.database)}).getCollection(${JSON.stringify(set.collection)})`;
    const lines: DocPreviewLine[] = atomic
      ? [
          control('const session = db.getMongo().startSession()'),
          control('session.startTransaction()'),
          control(`const coll = session.${names}`),
        ]
      : [
          control(
            `const coll = db.getSiblingDB(${JSON.stringify(set.database)}).getCollection(${JSON.stringify(set.collection)})`,
          ),
        ];
    exact.forEach((e, i) => lines.push({ text: opText(e), role: 'write', edit: i }));
    if (atomic) lines.push(control('session.commitTransaction()'));
    return { lines, operations: exact.length, atomic, topology };
  }

  function apply(
    connectionId: string,
    set: DocChangeSet,
    reverts: number | null,
  ): DocApplyOutcome | YadbeError {
    const session = host.session(connectionId);
    if (!session) return mockErrors.notConnected();
    if (session.readOnly) {
      return mockErrors.readOnlyViolation('a change of documents');
    }
    const planned = plan(set);
    if ('code' in planned) return planned;
    const { collection, exact } = planned;
    if (
      !staleDone &&
      set.database === MOCK_STALE_DOCUMENT.database &&
      set.collection === MOCK_STALE_DOCUMENT.collection &&
      exact.some((e) => text(idOf(e)) === MOCK_STALE_DOCUMENT.id)
    ) {
      staleDone = true;
      const stale = collection.documents[find(collection, parse(MOCK_STALE_DOCUMENT.id))];
      if (stale) stale.email = 'theirs@example.com';
    }
    const atomic = session.topology !== 'standalone';
    const outcome: DocApplyOutcome = {
      status: 'applied',
      atomic,
      applied: [],
      conflicts: [],
      error: null,
      retryable: false,
      journalId: null,
      revertible: false,
      insertedIds: [],
    };
    const log = (sql: string) => {
      host.logStatement(connectionId, `use ${set.database}; ${sql}`);
    };
    if (atomic) {
      log('session.startTransaction()');
      const conflicts = exact.map((e, i) => check(collection, e, i)).filter((c) => c !== null);
      exact.forEach((e) => {
        log(opText(e));
      });
      if (conflicts.length > 0) {
        log('session.abortTransaction()');
        return { ...outcome, status: 'conflicted', conflicts };
      }
      exact.forEach((e) => {
        run(collection, e);
      });
      log('session.commitTransaction()');
      outcome.applied = exact.map((_, i) => i);
    } else {
      for (const [i, e] of exact.entries()) {
        const conflict = check(collection, e, i);
        log(opText(e));
        if (conflict) {
          outcome.status = 'conflicted';
          outcome.conflicts = [conflict];
          break;
        }
        run(collection, e);
        outcome.applied.push(i);
      }
    }
    const applied = outcome.applied.map((i) => exact[i]).filter((e) => e !== undefined);
    outcome.insertedIds = outcome.applied
      .filter((i) => exact[i]?.kind === 'insert')
      .map((i) => [i, text(idOf(exact[i] as Exact)) ?? 'null']);
    if (applied.length === 0) return outcome;
    const statements: JournalStatement[] = applied.map((e) => ({
      sql: opText(e),
      rowsAffected: 1,
    }));
    const inverse: DocChangeSet = {
      database: set.database,
      collection: set.collection,
      edits: [...applied].reverse().map(inverseOf),
    };
    const count = (kinds: Exact['kind'][]) => applied.filter((e) => kinds.includes(e.kind)).length;
    outcome.journalId = host.journal.record({
      connectionId,
      connectionName: host.connectionName(connectionId),
      engine: 'mongodb',
      targetKind: 'collection',
      table: { database: set.database, schema: null, name: set.collection },
      durationMs: 4,
      counts: {
        updated: count(['update', 'replace']),
        inserted: count(['insert']),
        deleted: count(['delete']),
      },
      statements,
      inverse: null,
      docInverse: inverse,
      inverseStatements: inverse.edits.map((edit) => {
        const one = exactOf(edit);
        return 'code' in one ? '' : opText(one);
      }),
      blocker: null,
      reverts: outcome.status === 'applied' ? reverts : null,
    });
    outcome.revertible = true;
    return outcome;
  }

  const commands: Pick<
    Commands,
    'mongoPreviewChanges' | 'mongoApplyChanges' | 'mongoPreviewRevert' | 'mongoApplyRevert'
  > = {
    mongoPreviewChanges(connectionId, changes) {
      const session = host.session(connectionId);
      if (!session) return fail(mockErrors.notConnected());
      const planned = plan(changes);
      if ('code' in planned) return fail(planned);
      return ok(preview(changes, session.topology, planned.exact));
    },
    mongoApplyChanges(connectionId, changes) {
      const outcome = apply(connectionId, changes, null);
      return 'code' in outcome ? fail(outcome) : ok(outcome);
    },
    mongoPreviewRevert(connectionId, entryId) {
      const session = host.session(connectionId);
      if (!session) return fail(mockErrors.notConnected());
      const set = host.journal.docInverseFor(entryId, connectionId);
      if ('code' in set) return fail(set);
      const planned = plan(set);
      if ('code' in planned) return fail(planned);
      return ok(preview(set, session.topology, planned.exact));
    },
    mongoApplyRevert(connectionId, entryId) {
      const set = host.journal.docInverseFor(entryId, connectionId);
      if ('code' in set) return fail(set);
      const outcome = apply(connectionId, set, entryId);
      return 'code' in outcome ? fail(outcome) : ok(outcome);
    },
  };

  return {
    commands,
    reset(): void {
      staleDone = false;
    },
  };
}
