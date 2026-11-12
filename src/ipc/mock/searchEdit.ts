import type {
  SearchApplied,
  SearchApplyOutcome,
  SearchChangeSet,
  SearchDocVersion,
  SearchEdit,
  SearchEditBlock,
  SearchEditInfo,
  SearchEditPreview,
  SearchIndexWriteState,
  SearchStop,
  YadbeError,
} from '../bindings';
import type { YadbeClient } from '../client';
import { mockErrors } from '../mockErrors';
import type { MockJournal } from './journal';
import { MOCK_ALIASES, MOCK_DATA_STREAMS, type JsonObject, type MockIndex } from './searchData';

/**
 * Document edits of the mock Elasticsearch cluster (M4-8), mirroring `session::search::edit`:
 * an overlay over the computed documents (replaced, created, deleted, each with its
 * `_seq_no`), guarded writes, one document at a time stopping at the first failure, the
 * journal and reverts. `globalThis.__YADBE_MOCK_SEARCH__.touch(index, id)` changes a document
 * behind the user's back, so that a conflict can be shown.
 */

type Commands = YadbeClient['commands'];
type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

const ok = <T>(data: T): Result<T> => Promise.resolve({ status: 'ok', data });
const fail = <T>(error: YadbeError): Result<T> => Promise.resolve({ status: 'error', error });

export type SearchEditCommands = Pick<
  Commands,
  | 'searchEditInfo'
  | 'searchGetDocument'
  | 'searchPreviewChanges'
  | 'searchApplyChanges'
  | 'searchPreviewRevert'
  | 'searchApplyRevert'
>;

/** A document as the overlay holds it: `source` null once deleted. */
interface Version {
  source: JsonObject | null;
  seq: number;
}

/** One document of an index, with the overlay applied. */
export interface MockDoc {
  id: string;
  source: JsonObject;
  seq: number;
}

export interface SearchEditHost {
  indices(): ReadonlyMap<string, MockIndex>;
  session(connectionId: string): { readOnly: boolean } | null;
  logStatement(connectionId: string, sql: string, error?: YadbeError | null): void;
  connectionName(connectionId: string): string;
  journal: MockJournal;
}

const TERM = '1';

function query(params: [string, string | null][]): string {
  const parts = params
    .filter((p): p is [string, string] => p[1] !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/** The request of an edit, console style (mirror of `db::search::edit::plan`). */
export function mockEditRequest(edit: SearchEdit, pretty: boolean): string {
  const path = (id: string) => `/${encodeURIComponent(edit.index)}/_doc/${encodeURIComponent(id)}`;
  const refresh: [string, string | null] = ['refresh', 'wait_for'];
  // The text as typed: re-serializing it in JavaScript would round long numbers, which the
  // backend keeps exact.
  const body = (source: string) => (pretty ? source.trim() : source.replace(/\s*\n\s*/g, ''));
  switch (edit.kind) {
    case 'replace':
      return `PUT ${path(edit.id)}${query([
        ['if_seq_no', edit.guard.seqNo],
        ['if_primary_term', edit.guard.primaryTerm],
        ['routing', edit.routing],
        refresh,
      ])}\n${body(edit.source)}`;
    case 'delete':
      return `DELETE ${path(edit.id)}${query([
        ['if_seq_no', edit.guard.seqNo],
        ['if_primary_term', edit.guard.primaryTerm],
        ['routing', edit.routing],
        refresh,
      ])}`;
    case 'create': {
      const params = query([['op_type', 'create'], ['routing', edit.routing], refresh]);
      return edit.id
        ? `PUT ${path(edit.id)}${params}\n${body(edit.source)}`
        : `POST /${encodeURIComponent(edit.index)}/_doc${params}\n${body(edit.source)}`;
    }
  }
}

function isObjectText(text: string): boolean {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

export function createMockSearchEdits(host: SearchEditHost) {
  /** index → id → version, over the computed documents. */
  let overlay = new Map<string, Map<string, Version>>();
  /** index → ids created, in order. */
  let created = new Map<string, string[]>();
  let nextAuto = 1;

  function layer(index: string): Map<string, Version> {
    let map = overlay.get(index);
    if (!map) {
      map = new Map();
      overlay.set(index, map);
    }
    return map;
  }

  function baseDoc(index: MockIndex, id: string): JsonObject | null {
    // Ids are `<prefix><number>`: find the number cheaply, else scan.
    const match = /(\d+)$/.exec(id);
    if (match) {
      for (const candidate of [Number(match[1]), Number(match[1]) - 10_000]) {
        if (candidate >= 0 && candidate < index.count) {
          const doc = index.doc(candidate);
          if (doc.id === id) return doc.source;
        }
      }
    }
    return null;
  }

  function current(indexName: string, id: string): Version | null {
    const known = overlay.get(indexName)?.get(id);
    if (known) return known.source === null ? null : known;
    const index = host.indices().get(indexName);
    const base = index ? baseDoc(index, id) : null;
    return base ? { source: base, seq: 0 } : null;
  }

  /** The documents of an index, edits applied, in index order then created ones. */
  function* docs(index: MockIndex): Generator<MockDoc> {
    const edits = overlay.get(index.name);
    for (let i = 0; i < index.count; i++) {
      const { id, source } = index.doc(i);
      const edited = edits?.get(id);
      if (edited?.source === null) continue;
      yield { id, source: edited?.source ?? source, seq: edited?.seq ?? 0 };
    }
    for (const id of created.get(index.name) ?? []) {
      const version = edits?.get(id);
      if (version?.source) yield { id, source: version.source, seq: version.seq };
    }
  }

  function backingOf(name: string): string | null {
    const stream = MOCK_DATA_STREAMS.find((s) => s.name === name);
    const alias = MOCK_ALIASES.find((a) => a.name === name);
    return stream?.indices[0] ?? alias?.writeIndex ?? null;
  }

  function stateOf(index: string): SearchIndexWriteState {
    return {
      index,
      dataStream: MOCK_DATA_STREAMS.find((s) => s.indices.includes(index))?.name ?? null,
      closed: false,
      writeBlock: index.startsWith('.kibana') ? 'index.blocks.write' : null,
      refreshDisabled: false,
    };
  }

  function blockOf(edit: SearchEdit, readOnly: boolean): SearchEditBlock | null {
    if (readOnly) return { kind: 'readOnlyConnection' };
    const backing = edit.kind === 'create' ? backingOf(edit.index) : null;
    const name = backing ?? edit.index;
    if (!host.indices().has(name)) return { kind: 'unknownIndex', index: name };
    const state = stateOf(name);
    if (state.dataStream !== null && edit.kind !== 'create') {
      return { kind: 'dataStream', name: state.dataStream };
    }
    if (state.writeBlock !== null) {
      return { kind: 'writeBlock', index: name, setting: state.writeBlock };
    }
    return null;
  }

  function blockError(block: SearchEditBlock): YadbeError {
    if (block.kind === 'readOnlyConnection') {
      return {
        ...mockErrors.readOnlyViolation('document edit'),
        message: {
          en: 'This connection is read-only: documents cannot be changed. Nothing was sent.',
          fr: 'Cette connexion est en lecture seule : les documents ne peuvent pas être modifiés. Rien n’a été envoyé.',
        },
      };
    }
    const en =
      block.kind === 'dataStream'
        ? `This document belongs to the data stream ${block.name}: a data stream is append-only, its documents are not changed here (use the console).`
        : block.kind === 'writeBlock'
          ? `The index ${block.index} refuses writes (${block.setting} is set).`
          : 'This document cannot be changed here.';
    return mockErrors.invalidArgument(`${en} Nothing was sent.`, `${en} Rien n’a été envoyé.`);
  }

  function version(index: string, id: string): SearchDocVersion {
    const now = current(index, id);
    return {
      index,
      id,
      routing: null,
      found: now !== null,
      guard: now ? { seqNo: String(now.seq), primaryTerm: TERM } : null,
      source: now?.source ? JSON.stringify(now.source, null, 2) : null,
    };
  }

  function apply(connectionId: string, set: SearchChangeSet, reverts: number | null) {
    const session = host.session(connectionId);
    if (!session) return mockErrors.notConnected();
    for (const edit of set.edits) {
      const block = blockOf(edit, session.readOnly);
      if (block) return blockError(block);
      if (edit.kind !== 'delete' && !isObjectText(edit.source)) {
        return mockErrors.invalidArgument(
          'A document is a JSON object ({ … }).',
          'Un document est un objet JSON ({ … }).',
        );
      }
    }
    const started = Date.now();
    const applied: SearchApplied[] = [];
    const statements: string[] = [];
    const inverse: SearchEdit[] = [];
    let stopped: SearchStop | null = null;
    let revertible = true;
    for (const [number, edit] of set.edits.entries()) {
      if (edit.kind === 'create') {
        const index = backingOf(edit.index) ?? edit.index;
        const id = edit.id ?? `auto-${String(nextAuto++)}`;
        if (current(index, id)) {
          stopped = {
            edit: number,
            reason: { kind: 'conflict', conflict: { kind: 'exists', current: version(index, id) } },
          };
          break;
        }
        const seq = (overlay.get(index)?.get(id)?.seq ?? 0) + 1;
        layer(index).set(id, { source: JSON.parse(edit.source) as JsonObject, seq });
        const base = host.indices().get(index);
        if (!created.get(index)?.includes(id) && !(base && baseDoc(base, id))) {
          created.set(index, [...(created.get(index) ?? []), id]);
        }
        applied.push({
          edit: number,
          index,
          id,
          result: 'created',
          guard: { seqNo: String(seq), primaryTerm: TERM },
        });
        if (
          backingOf(edit.index) !== null &&
          MOCK_DATA_STREAMS.some((s) => s.name === edit.index)
        ) {
          revertible = false;
        }
        inverse.push({
          kind: 'delete',
          index,
          id,
          routing: edit.routing,
          guard: { seqNo: String(seq), primaryTerm: TERM },
        });
      } else {
        const now = current(edit.index, edit.id);
        if (!now?.source || String(now.seq) !== edit.guard.seqNo) {
          stopped = {
            edit: number,
            reason: {
              kind: 'conflict',
              conflict: {
                kind: now ? 'changed' : 'missing',
                current: version(edit.index, edit.id),
              },
            },
          };
          break;
        }
        const seq = now.seq + 1;
        const previous = JSON.stringify(now.source);
        if (edit.kind === 'replace') {
          layer(edit.index).set(edit.id, {
            source: JSON.parse(edit.source) as JsonObject,
            seq,
          });
          inverse.push({
            kind: 'replace',
            index: edit.index,
            id: edit.id,
            routing: edit.routing,
            guard: { seqNo: String(seq), primaryTerm: TERM },
            source: previous,
          });
        } else {
          layer(edit.index).set(edit.id, { source: null, seq });
          inverse.push({
            kind: 'create',
            index: edit.index,
            id: edit.id,
            routing: edit.routing,
            source: previous,
          });
        }
        applied.push({
          edit: number,
          index: edit.index,
          id: edit.id,
          result: edit.kind === 'replace' ? 'updated' : 'deleted',
          guard: { seqNo: String(seq), primaryTerm: TERM },
        });
      }
      const text = mockEditRequest(edit, false);
      statements.push(text);
      host.logStatement(connectionId, text);
    }
    let journalId: number | null = null;
    if (applied.length > 0) {
      const done = set.edits.slice(0, applied.length);
      const back: SearchChangeSet = { target: set.target, edits: inverse.reverse() };
      journalId = host.journal.record({
        connectionId,
        connectionName: host.connectionName(connectionId),
        engine: 'elasticsearch',
        targetKind: 'index',
        table: { database: '', schema: null, name: set.target },
        durationMs: Date.now() - started,
        counts: {
          updated: done.filter((e) => e.kind === 'replace').length,
          inserted: done.filter((e) => e.kind === 'create').length,
          deleted: done.filter((e) => e.kind === 'delete').length,
        },
        statements: statements.map((sql) => ({ sql, rowsAffected: 1 })),
        inverse: null,
        searchInverse: revertible ? back : null,
        inverseStatements: revertible ? back.edits.map((e) => mockEditRequest(e, false)) : [],
        blocker: revertible ? null : { kind: 'notPlannable' },
        reverts: stopped === null ? reverts : null,
      });
    }
    const outcome: SearchApplyOutcome = {
      total: set.edits.length,
      applied,
      stopped,
      journalId,
      revertible: journalId !== null && revertible,
      notVisible: [],
    };
    return outcome;
  }

  function preview(connectionId: string, set: SearchChangeSet): SearchEditPreview | YadbeError {
    const session = host.session(connectionId);
    if (!session) return mockErrors.notConnected();
    for (const edit of set.edits) {
      if (edit.kind !== 'delete' && !isObjectText(edit.source)) {
        return mockErrors.invalidArgument(
          'The document is not valid JSON.',
          'Le document n’est pas du JSON valide.',
        );
      }
    }
    return {
      requests: set.edits.map((edit, i) => ({
        edit: i,
        text: mockEditRequest(edit, true),
        waits: true,
      })),
      refused: set.edits.flatMap((edit, i) => {
        const reason = blockOf(edit, session.readOnly);
        return reason ? [{ edit: i, reason }] : [];
      }),
    };
  }

  const commands: SearchEditCommands = {
    searchEditInfo(connectionId, target) {
      const session = host.session(connectionId);
      if (!session) return fail(mockErrors.notConnected());
      const stream = MOCK_DATA_STREAMS.find((s) => s.name === target);
      const alias = MOCK_ALIASES.find((a) => a.name === target);
      const names = stream?.indices ?? alias?.indices ?? [target];
      const indices = names.filter((n) => host.indices().has(n)).map(stateOf);
      const usable = indices.every((s) => s.dataStream === null && s.writeBlock === null);
      const info: SearchEditInfo = {
        readOnly: session.readOnly,
        indices,
        dataStreams: stream ? [stream.name] : [],
        createTargets:
          session.readOnly || indices.length === 0 ? [] : stream || alias || usable ? [target] : [],
      };
      host.logStatement(connectionId, `GET /_resolve/index/${target}?expand_wildcards=all`);
      return ok(info);
    },
    searchGetDocument(connectionId, index, id) {
      if (!host.session(connectionId)) return fail(mockErrors.notConnected());
      host.logStatement(connectionId, `GET /${index}/_doc/${id}`);
      return ok(version(index, id));
    },
    searchPreviewChanges(connectionId, changes) {
      const result = preview(connectionId, changes);
      return 'code' in result ? fail(result) : ok(result);
    },
    searchApplyChanges(connectionId, changes) {
      const result = apply(connectionId, changes, null);
      return 'code' in result ? fail(result) : ok(result);
    },
    searchPreviewRevert(connectionId, entryId) {
      const inverse = host.journal.searchInverseFor(entryId, connectionId);
      if ('code' in inverse) return fail(inverse);
      const result = preview(connectionId, inverse);
      return 'code' in result ? fail(result) : ok({ changes: inverse, preview: result });
    },
    searchApplyRevert(connectionId, entryId) {
      const inverse = host.journal.searchInverseFor(entryId, connectionId);
      if ('code' in inverse) return fail(inverse);
      const result = apply(connectionId, inverse, entryId);
      return 'code' in result ? fail(result) : ok(result);
    },
  };

  const touch = (index: string, id: string): boolean => {
    const now = current(index, id);
    if (!now?.source) return false;
    layer(index).set(id, { source: { ...now.source, touched: true }, seq: now.seq + 1 });
    return true;
  };
  (globalThis as { __YADBE_MOCK_SEARCH__?: { touch: typeof touch } }).__YADBE_MOCK_SEARCH__ = {
    touch,
  };

  return {
    commands,
    docs,
    reset(): void {
      overlay = new Map();
      created = new Map();
      nextAuto = 1;
    },
  };
}

export type MockSearchEdits = ReturnType<typeof createMockSearchEdits>;
