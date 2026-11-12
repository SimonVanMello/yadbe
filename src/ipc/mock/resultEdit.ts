import type {
  ApplyOutcome,
  ChangeSet,
  ColumnMeta,
  Engine,
  ObjectRef,
  RefreshedRows,
  ResultEditColumn,
  ResultEditInfo,
  ResultReadOnlyReason,
  ResultRowRef,
  ResultWindow,
  TableDetails,
  TransactionState,
  Value,
  YadbeError,
} from '../bindings';
import type { YadbeClient } from '../client';
import { mockErrors } from '../mockErrors';
import {
  cellValue,
  type Cell,
  type MockColumn,
  type MockResultOrigin,
  type MockTableSelect,
} from '../mockQuery';
import { info as tableInfo, mockValueText, rowIdentity, type TableDataCommands } from './tableData';

type Commands = YadbeClient['commands'];
type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

/** The result edit commands the mock implements (M3-7, F-087). */
export type ResultEditCommands = Pick<
  Commands,
  | 'describeResultEdit'
  | 'previewResultChanges'
  | 'applyResultChanges'
  | 'refreshResultRows'
  | 'removeResultRows'
  | 'cancelResultEdit'
  | 'closeResultEdit'
>;

export interface ResultEditDeps {
  origin(resultId: number): MockResultOrigin | undefined;
  tabTransaction(tabId: string): TransactionState;
  session(connectionId: string): { engine: Engine; readOnly: boolean } | null;
  relation(
    connectionId: string,
    table: ObjectRef,
  ): { details: TableDetails; enums: Map<string, string[]> } | null;
  tables: Pick<
    TableDataCommands,
    | 'openTableData'
    | 'previewTableChanges'
    | 'applyTableChanges'
    | 'refreshTableRows'
    | 'cancelTableData'
    | 'closeTableData'
  >;
  storeRows(columns: readonly ColumnMeta[], rows: readonly (readonly Cell[])[]): number;
  freeResults(ids: readonly number[]): void;
  window(resultId: number, offset: number, limit: number): ResultWindow | null;
  /** Stored row `row` of a result becomes what an apply read back. */
  patchRow(resultId: number, row: number, cells: readonly Cell[]): void;
  /** Stored rows an apply deleted leave what the grid shows; `false`: no such result. */
  removeRows(resultId: number, rows: readonly number[]): boolean;
}

function ok<T>(data: T): Result<T> {
  return Promise.resolve({ status: 'ok', data });
}

function fail<T>(error: YadbeError): Result<T> {
  return Promise.resolve({ status: 'error', error });
}

/** A plain `SELECT` of one schema-qualified table, as the mock understands it. */
export interface ParsedTableSelect {
  schema: string;
  table: string;
  /** `null`: `*`. Each item: the column it reads, `null` for an expression, and its name. */
  items: { column: string | null; name: string }[] | null;
  limit: number | null;
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const unquote = (ident: string) =>
  ident.startsWith('"') ? ident.slice(1, -1).replace(/""/g, '"') : ident.toLowerCase();

/**
 * `SELECT <list> FROM <schema>.<table> [[AS] alias] [LIMIT n] [;]`; anything else (a join, a
 * `WHERE`, a subquery…) is not one, and gets the canned sample result.
 */
export function parseTableSelect(sql: string): ParsedTableSelect | null {
  const match = new RegExp(
    String.raw`^\s*select\s+(.+?)\s+from\s+(${IDENT})\.(${IDENT})(?:\s+(?:as\s+)?(?!limit\b)(${IDENT}))?(?:\s+limit\s+(\d+))?\s*;?\s*$`,
    'is',
  ).exec(sql);
  if (!match) return null;
  const [, list = '', schema = '', table = '', alias, limit] = match;
  const prefix = alias ? `${unquote(alias)}.` : null;
  let items: ParsedTableSelect['items'] = null;
  if (list.trim() !== '*') {
    items = [];
    for (const raw of list.split(',')) {
      const expr = raw.trim();
      const aliased = new RegExp(String.raw`^(.+?)\s+as\s+(${IDENT})$`, 'is').exec(expr);
      const body = aliased?.[1]?.trim() ?? expr;
      const plain = new RegExp(String.raw`^(?:${IDENT}\.)?(${IDENT})$`).exec(body);
      const qualifier = /^(.+)\.[^.]+$/.exec(body)?.[1];
      const column =
        plain?.[1] && (!qualifier || !prefix || `${unquote(qualifier)}.` === prefix)
          ? unquote(plain[1])
          : null;
      items.push({ column, name: aliased?.[2] ? unquote(aliased[2]) : (column ?? body) });
    }
  }
  return {
    schema: unquote(schema),
    table: unquote(table),
    items,
    limit: limit === undefined ? null : Number(limit),
  };
}

/**
 * The result of a plain `SELECT` of one mock table: a snapshot of its rows, columns as listed
 * (an expression reads as its text, computed).
 */
export function tableSelect(
  parsed: ParsedTableSelect,
  connectionId: string,
  table: ObjectRef,
  details: TableDetails,
  rows: readonly (readonly Cell[])[],
): MockTableSelect {
  const items =
    parsed.items ?? details.columns.map((column) => ({ column: column.name, name: column.name }));
  const snapshot = rows.slice(0, parsed.limit ?? rows.length).map((row) => [...row]);
  const columns: MockColumn[] = items.map((item) => {
    const c =
      item.column === null ? -1 : details.columns.findIndex((col) => col.name === item.column);
    const column = details.columns[c];
    if (!column) {
      return {
        meta: { name: item.name, typeName: 'text', kind: 'text' },
        cell: (r: number) => ['text', `${item.name} ${String(r + 1)}`] as const,
      };
    }
    return {
      meta: { name: item.name, typeName: column.typeName, kind: column.kind },
      cell: (r: number) => snapshot[r]?.[c] ?? null,
    };
  });
  return {
    columns,
    total: snapshot.length,
    edit: {
      connectionId,
      table,
      sources: items.map((item) =>
        item.column !== null && details.columns.some((c) => c.name === item.column)
          ? item.column
          : null,
      ),
    },
  };
}

/** Result editing of the mock backend: a hidden table tab per edited result, as the backend. */
export function createMockResultEdit(deps: ResultEditDeps) {
  /** Results described as editable, with what they need. */
  const edits = new Map<
    number,
    {
      tabId: string;
      connectionId: string;
      table: ObjectRef;
      sources: (string | null)[];
      columns: ColumnMeta[];
      opened: boolean;
      results: number[];
    }
  >();

  const hidden = (resultId: number) => `result:${String(resultId)}`;

  function computed(meta: ColumnMeta): ResultEditColumn {
    return {
      source: null,
      column: {
        name: meta.name,
        typeName: meta.typeName,
        kind: meta.kind,
        nullable: true,
        default: null,
        optionalOnInsert: true,
        primaryKey: false,
        readOnlyReason: 'computed',
        enumValues: null,
      },
    };
  }

  function describe(resultId: number): ResultEditInfo | YadbeError {
    const origin = deps.origin(resultId);
    if (!origin) return mockErrors.resultNotFound(resultId);
    const session = deps.session(origin.connectionId);
    if (!session) return mockErrors.notConnected();
    const out: ResultEditInfo = {
      resultId,
      table: null,
      readOnlyReasons: [],
      columns: origin.columns.map(computed),
      rowIdentity: [],
      identityColumns: [],
    };
    const refuse = (reason: ResultReadOnlyReason): ResultEditInfo => {
      edits.delete(resultId);
      out.readOnlyReasons = session.readOnly ? [reason, 'readOnlyConnection'] : [reason];
      return out;
    };
    if (!origin.edit) return refuse(origin.complex ? 'notSingleTable' : 'originUnknown');
    const { table, sources } = origin.edit;
    out.table = table;
    const relation = deps.relation(origin.connectionId, table);
    if (!relation) return refuse('tableUnknown');
    const described = tableInfo(relation.details, relation.enums, session.readOnly);
    const reasons: ResultReadOnlyReason[] = [];
    const identity = rowIdentity(relation.details);
    if (relation.details.kind !== 'table') reasons.push('view');
    else if (!identity) reasons.push('noRowIdentity');
    const used = new Set<string>();
    const mapped = sources.map((source) => {
      if (source === null || used.has(source)) return null;
      used.add(source);
      return source;
    });
    out.columns = origin.columns.map((meta, i) => {
      const source = mapped[i] ?? null;
      const column = source === null ? undefined : described.columns.find((c) => c.name === source);
      return column ? { source, column } : computed(meta);
    });
    out.rowIdentity = identity ?? [];
    const identityColumns: number[] = [];
    if (reasons.length === 0) {
      for (const name of out.rowIdentity) {
        const at = mapped.indexOf(name);
        if (at < 0) {
          reasons.push('keyNotSelected');
          break;
        }
        identityColumns.push(at);
      }
    }
    if (session.readOnly) reasons.push('readOnlyConnection');
    out.readOnlyReasons = reasons;
    if (reasons.length > 0) {
      edits.delete(resultId);
      return out;
    }
    out.identityColumns = identityColumns;
    const previous = edits.get(resultId);
    edits.set(resultId, {
      tabId: origin.tabId,
      connectionId: origin.connectionId,
      table,
      sources: mapped,
      columns: origin.columns,
      opened: previous?.opened ?? false,
      results: previous?.results ?? [],
    });
    return out;
  }

  async function editOf(resultId: number) {
    if (!deps.origin(resultId)) return mockErrors.resultNotFound(resultId);
    if (!edits.has(resultId)) {
      const described = describe(resultId);
      if ('code' in described) return described;
      const reason = described.readOnlyReasons[0];
      if (reason) {
        if (described.readOnlyReasons.includes('readOnlyConnection')) {
          return mockErrors.readOnlyViolation('UPDATE');
        }
        return mockErrors.tableNotEditable(
          `This result cannot be edited (${reason}).`,
          `Ce résultat ne peut pas être modifié (${reason}).`,
        );
      }
    }
    const opened = edits.get(resultId);
    if (!opened) return mockErrors.resultNotFound(resultId);
    if (!opened.opened) {
      const result = await deps.tables.openTableData(
        hidden(resultId),
        opened.connectionId,
        opened.table,
      );
      if (result.status === 'error') return result.error;
      opened.opened = true;
    }
    return opened;
  }

  function check(sources: (string | null)[], changes: ChangeSet): YadbeError | null {
    if (changes.inserts.length > 0) {
      return mockErrors.invalidArgument(
        'Rows cannot be added to a query result: open the table to insert rows.',
        'On ne peut pas ajouter de lignes à un résultat de requête : ouvrez la table pour insérer des lignes.',
      );
    }
    const known = new Set(sources.filter((s): s is string => s !== null));
    const unknown = [
      ...changes.updates.map((u) => u.column),
      ...changes.deletes.flatMap((d) => (d.values ?? []).map((v) => v.column)),
    ].find((column) => !known.has(column));
    return unknown === undefined
      ? null
      : mockErrors.invalidArgument(
          `The result does not show the table column "${unknown}" as it is stored.`,
          `Le résultat ne montre pas la colonne « ${unknown} » de la table telle qu'elle est stockée.`,
        );
  }

  /**
   * Rows a hidden table tab read (table columns), in the result's columns; a row read with its
   * stored row (`rows[i]`) replaces it in the result, as the backend does.
   */
  function remap(
    edit: {
      connectionId: string;
      table: ObjectRef;
      sources: (string | null)[];
      columns: ColumnMeta[];
      results: number[];
    },
    read: RefreshedRows,
    resultId: number,
    rows: (number | null)[],
  ): RefreshedRows {
    const origin = deps.origin(resultId);
    // A table tab's windows follow the table's columns.
    const order = deps.relation(edit.connectionId, edit.table)?.details.columns.map((c) => c.name);
    const out: Cell[][] = [];
    const positions = read.positions.map((position, i) => {
      if (position === null) return null;
      const row = edit.columns.map((meta, c): Cell => {
        const source = edit.sources[c] ?? null;
        if (source === null) {
          const at = rows[i];
          const value: Value =
            at === null || at === undefined || !origin ? { kind: 'null' } : origin.value(at, c);
          const text = mockValueText(value);
          return text === null || value.kind === 'null' ? null : [value.kind, text];
        }
        const column = read.window.columns[order?.indexOf(source) ?? -1];
        const text = column?.values[position] ?? null;
        return text === null ? null : [column?.kinds?.[position] ?? meta.kind, text];
      });
      const at = rows[i];
      if (at !== null && at !== undefined && origin) deps.patchRow(resultId, at, row);
      out.push(row);
      return out.length - 1;
    });
    const id = deps.storeRows(edit.columns, out);
    edit.results.push(id);
    return {
      window: deps.window(id, 0, 500) ?? { ...read.window, resultId: id },
      positions,
    };
  }

  /** Deleted rows with the table columns the result does not show, as stored now (F-090). */
  async function completeDeletes(
    edit: { connectionId: string; table: ObjectRef },
    resultId: number,
    changes: ChangeSet,
  ): Promise<ChangeSet | YadbeError> {
    if (changes.deletes.length === 0) return changes;
    const read = await deps.tables.refreshTableRows(
      hidden(resultId),
      changes.deletes.map((d) => d.key),
    );
    if (read.status === 'error') return read.error;
    const order = deps.relation(edit.connectionId, edit.table)?.details.columns ?? [];
    return {
      ...changes,
      deletes: changes.deletes.map((d, i) => {
        const position = read.data.positions[i];
        if (position === null || position === undefined) return d;
        const values = [...(d.values ?? [])];
        order.forEach((column, c) => {
          if (values.some((v) => v.column === column.name)) return;
          const window = read.data.window.columns[c];
          const text = window?.values[position] ?? null;
          const kind = window?.kinds?.[position] ?? column.kind;
          values.push({
            column: column.name,
            value: text === null ? { kind: 'null' } : cellValue([kind, text]),
          });
        });
        return { ...d, values };
      }),
    };
  }

  const commands: ResultEditCommands = {
    describeResultEdit: (resultId) => {
      const described = describe(resultId);
      return 'code' in described ? fail(described) : ok(described);
    },
    previewResultChanges: async (resultId, changes) => {
      const edit = await editOf(resultId);
      if ('code' in edit) return fail(edit);
      const problem = check(edit.sources, changes);
      if (problem) return fail(problem);
      // As Apply will run them: deleted rows checked on every column.
      const completed = await completeDeletes(edit, resultId, changes);
      if ('code' in completed) return fail(completed);
      return deps.tables.previewTableChanges(hidden(resultId), completed);
    },
    applyResultChanges: async (resultId, changes) => {
      const edit = await editOf(resultId);
      if ('code' in edit) return fail(edit);
      const problem = check(edit.sources, changes);
      if (problem) return fail(problem);
      if (deps.session(edit.connectionId)?.readOnly) {
        return fail(mockErrors.readOnlyViolation('UPDATE'));
      }
      if (deps.tabTransaction(edit.tabId).status !== 'idle') {
        return fail(
          mockErrors.tableNotEditable(
            'A transaction is open in this query tab: commit or roll it back first. Changes to a result are applied in a transaction of their own.',
            "Une transaction est ouverte dans cet onglet de requête : validez-la ou annulez-la d'abord. Les modifications d'un résultat sont appliquées dans leur propre transaction.",
          ),
        );
      }
      const completed = await completeDeletes(edit, resultId, changes);
      if ('code' in completed) return fail(completed);
      const result = await deps.tables.applyTableChanges(hidden(resultId), completed);
      if (result.status === 'error') return result;
      const outcome: ApplyOutcome = result.data;
      if (outcome.status !== 'conflicted') return ok(outcome);
      return ok({
        ...outcome,
        current: remap(
          edit,
          outcome.current,
          resultId,
          outcome.current.positions.map(() => null),
        ),
      });
    },
    refreshResultRows: async (resultId, rows: ResultRowRef[]) => {
      const edit = await editOf(resultId);
      if ('code' in edit) return fail(edit);
      const read = await deps.tables.refreshTableRows(
        hidden(resultId),
        rows.map((r) => r.key),
      );
      if (read.status === 'error') return read;
      return ok(
        remap(
          edit,
          read.data,
          resultId,
          rows.map((r) => r.row),
        ),
      );
    },
    removeResultRows: (resultId, rows) => {
      if (!edits.has(resultId)) return fail(mockErrors.resultNotFound(resultId));
      if (!deps.removeRows(resultId, rows)) return fail(mockErrors.resultNotFound(resultId));
      return ok(null);
    },
    cancelResultEdit: (resultId) => deps.tables.cancelTableData(hidden(resultId)),
    closeResultEdit: async (resultId) => {
      const edit = edits.get(resultId);
      edits.delete(resultId);
      if (edit) {
        deps.freeResults(edit.results);
        if (edit.opened) await deps.tables.closeTableData(hidden(resultId));
      }
      return { status: 'ok', data: null };
    },
  };

  return {
    commands,
    reset(): void {
      edits.clear();
    },
  };
}

export type MockResultEdit = ReturnType<typeof createMockResultEdit>;
