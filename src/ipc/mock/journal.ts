import type {
  ChangeSet,
  Engine,
  EngineFamily,
  JournalTargetKind,
  KvChangeSet,
  JournalDetail,
  JournalEntry,
  JournalPage,
  JournalQuery,
  JournalStatement,
  JournalTable,
  ObjectRef,
  RevertBlocker,
  YadbeError,
} from '../bindings';
import type { YadbeClient } from '../client';
import type { EventEmitter } from '../emitter';
import { mockErrors } from '../mockErrors';

type Commands = YadbeClient['commands'];
type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

/** The change journal commands the mock implements on its own (M3-6, F-090). */
export type JournalCommands = Pick<
  Commands,
  'searchChangeJournal' | 'getChangeJournalEntry' | 'listChangeJournalTables' | 'clearChangeJournal'
>;

const PAGE_SIZE = 200;
const PREVIEW_CHARS = 300;
const DEFAULT_MAX_ENTRIES = 1000;

/** A change set to record, as the table data mock knows it. */
export interface MockJournalRecord {
  connectionId: string;
  connectionName: string;
  engine: Engine;
  table: ObjectRef;
  durationMs: number;
  counts: { updated: number; inserted: number; deleted: number };
  statements: JournalStatement[];
  inverse: ChangeSet | null;
  inverseStatements: string[];
  blocker: RevertBlocker | null;
  reverts: number | null;
  /** What `table` names; a table when absent. */
  targetKind?: JournalTargetKind;
  /** The inverse of a key-value change set (`inverse` is SQL only). */
  kvInverse?: KvChangeSet | null;
}

function familyOf(engine: Engine): EngineFamily {
  switch (engine) {
    case 'redis':
      return 'keyValue';
    case 'mongodb':
      return 'document';
    default:
      return 'sql';
  }
}

interface Stored extends MockJournalRecord {
  id: number;
  appliedAt: number;
  revertedBy: number | null;
}

function ok<T>(data: T): Result<T> {
  return Promise.resolve({ status: 'ok', data });
}

function sameTable(a: ObjectRef, b: ObjectRef): boolean {
  return (
    a.name === b.name &&
    (a.schema === null || b.schema === null || a.schema === b.schema) &&
    (a.database === '' || b.database === '' || a.database === b.database)
  );
}

function entryOf(stored: Stored): JournalEntry {
  return {
    id: stored.id,
    connectionId: stored.connectionId,
    connectionName: stored.connectionName,
    engine: stored.engine,
    family: familyOf(stored.engine),
    targetKind: stored.targetKind ?? 'table',
    table: structuredClone(stored.table),
    appliedAt: stored.appliedAt,
    durationMs: stored.durationMs,
    updated: stored.counts.updated,
    inserted: stored.counts.inserted,
    deleted: stored.counts.deleted,
    statementCount: stored.statements.length,
    preview: (stored.statements[0]?.sql ?? '').slice(0, PREVIEW_CHARS),
    revertBlocker: stored.blocker ? structuredClone(stored.blocker) : null,
    reverts: stored.reverts,
    revertedBy: stored.revertedBy,
  };
}

/** The change journal of the mock backend: in memory, newest first. */
export function createMockJournal(deps: { events: EventEmitter }) {
  let entries: Stored[] = [];
  let nextId = 1;
  let maxEntries = DEFAULT_MAX_ENTRIES;

  function changed(): void {
    deps.events.emit('changeJournalChanged', {});
  }

  function prune(): void {
    if (entries.length > maxEntries) entries = entries.slice(entries.length - maxEntries);
  }

  function matches(stored: Stored, query: JournalQuery): boolean {
    const text = query.text?.trim().toLowerCase();
    if (text && !stored.statements.some((s) => s.sql.toLowerCase().includes(text))) return false;
    if (query.connectionId && stored.connectionId !== query.connectionId) return false;
    if (query.table && !sameTable(stored.table, query.table)) return false;
    if (query.after !== null && stored.id >= query.after) return false;
    return true;
  }

  const commands: JournalCommands = {
    searchChangeJournal: (query) => {
      const limit = Math.min(Math.max(query.limit ?? PAGE_SIZE, 1), PAGE_SIZE);
      const found = [...entries].reverse().filter((stored) => matches(stored, query));
      const page = found.slice(0, limit).map(entryOf);
      const result: JournalPage = {
        entries: page,
        next: found.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
      return ok(result);
    },
    getChangeJournalEntry: (id) => {
      const stored = entries.find((e) => e.id === id);
      const detail: JournalDetail | null = stored
        ? {
            entry: entryOf(stored),
            statements: structuredClone(stored.statements),
            inverseStatements: [...stored.inverseStatements],
          }
        : null;
      return ok(detail);
    },
    listChangeJournalTables: (connectionId) => {
      const tables: JournalTable[] = [];
      for (const stored of [...entries].reverse()) {
        if (connectionId !== null && stored.connectionId !== connectionId) continue;
        const known = tables.find(
          (t) => t.connectionId === stored.connectionId && sameTable(t.table, stored.table),
        );
        if (known) known.entries++;
        else
          tables.push({
            connectionId: stored.connectionId,
            table: structuredClone(stored.table),
            entries: 1,
          });
      }
      return ok(tables);
    },
    clearChangeJournal: (connectionId) => {
      const before = entries.length;
      entries = entries.filter((e) => connectionId !== null && e.connectionId !== connectionId);
      changed();
      return ok(before - entries.length);
    },
  };

  return {
    commands,
    /** Records an applied change set; returns its id. */
    record(record: MockJournalRecord): number {
      const id = nextId++;
      entries.push({ ...structuredClone(record), id, appliedAt: Date.now(), revertedBy: null });
      if (record.reverts !== null) {
        const reverted = entries.find((e) => e.id === record.reverts);
        if (reverted) reverted.revertedBy = id;
      }
      prune();
      changed();
      return id;
    },
    /** The inverse of an entry for a revert on `table`, or why it cannot be. */
    inverseFor(id: number, connectionId: string, table: ObjectRef): ChangeSet | YadbeError {
      const stored = entries.find((e) => e.id === id);
      if (!stored) {
        return mockErrors.invalidArgument(
          'This change set is no longer in the journal.',
          "Cet ensemble de modifications n'est plus dans le journal.",
        );
      }
      if (stored.connectionId !== connectionId || !sameTable(stored.table, table)) {
        return mockErrors.invalidArgument(
          'This change set was applied to another table.',
          'Cet ensemble de modifications a été appliqué à une autre table.',
        );
      }
      if (stored.revertedBy !== null) {
        return mockErrors.invalidArgument(
          `This change set was already reverted (#${String(stored.revertedBy)}).`,
          `Cet ensemble de modifications a déjà été annulé (n° ${String(stored.revertedBy)}).`,
        );
      }
      if (stored.blocker || !stored.inverse) {
        return mockErrors.invalidArgument(
          'This change set cannot be reverted faithfully.',
          'Cet ensemble de modifications ne peut pas être annulé fidèlement.',
        );
      }
      return structuredClone(stored.inverse);
    },
    /** The inverse of a key-value entry for a revert on `connectionId`, or why it cannot be. */
    kvInverseFor(id: number, connectionId: string): KvChangeSet | YadbeError {
      const stored = entries.find((e) => e.id === id);
      if (!stored) {
        return mockErrors.invalidArgument(
          'This change set is no longer in the journal.',
          "Cet ensemble de modifications n'est plus dans le journal.",
        );
      }
      if (stored.connectionId !== connectionId || familyOf(stored.engine) !== 'keyValue') {
        return mockErrors.invalidArgument(
          'This change set was applied to another connection.',
          'Cet ensemble de modifications a été appliqué à une autre connexion.',
        );
      }
      if (stored.revertedBy !== null) {
        return mockErrors.invalidArgument(
          `This change set was already reverted (#${String(stored.revertedBy)}).`,
          `Cet ensemble de modifications a déjà été annulé (n° ${String(stored.revertedBy)}).`,
        );
      }
      if (stored.blocker || !stored.kvInverse) {
        return mockErrors.invalidArgument(
          'This change set cannot be reverted faithfully.',
          'Cet ensemble de modifications ne peut pas être annulé fidèlement.',
        );
      }
      return structuredClone(stored.kvInverse);
    },
    setMaxEntries(max: number): void {
      maxEntries = max;
      prune();
    },
    reset(): void {
      entries = [];
      nextId = 1;
      maxEntries = DEFAULT_MAX_ENTRIES;
    },
  };
}

export type MockJournal = ReturnType<typeof createMockJournal>;
