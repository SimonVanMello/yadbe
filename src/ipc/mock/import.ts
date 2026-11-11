import type {
  Engine,
  ImportAnalysis,
  ImportColumnCheck,
  ImportFinished,
  ImportReject,
  ImportRequest,
  ImportTarget,
  ImportTargetColumn,
  ObjectRef,
  TableDetails,
  YadbeError,
} from '../bindings';
import type { YadbeCommands } from '../client';
import type { EventEmitter } from '../emitter';
import { mockErrors } from '../mockErrors';
import { checkCell } from './importConvert';
import { detectOptions, MockParseError, readFile, type MockParsed } from './importParse';

type ImportCommands = Pick<
  YadbeCommands,
  'previewImportFile' | 'getImportTarget' | 'analyzeImport' | 'startImport' | 'cancelImport'
>;

type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

const ok = <T>(data: T): Result<T> => Promise.resolve({ status: 'ok', data });
const fail = <T>(error: YadbeError): Result<T> => Promise.resolve({ status: 'error', error });

/** Extensions an import file may have (`import/manager.rs`). */
const IMPORT_EXTENSIONS = ['csv', 'tsv', 'txt', 'json', 'jsonl', 'ndjson'];
const REJECTS_EXTENSIONS = ['csv', 'txt'];

const DEFAULT_TICK_MS = 40;
/** Rows converted per simulated step. */
const STEP_ROWS = 2000;
const ANALYZE_ROWS = 10_000;
const MAX_PREVIEW_ROWS = 200;
const SAMPLE_REJECTS = 50;
const VALUE_CHARS = 80;

export interface MockImportHost {
  events: EventEmitter;
  readFile(path: string): string | undefined;
  writeFile(path: string, text: string): void;
  relation(connectionId: string, table: ObjectRef): { details: TableDetails } | null;
  session(connectionId: string): { engine: Engine; readOnly: boolean } | null;
  logStatement(connectionId: string, sql: string, error?: YadbeError | null): void;
}

function pathProblem(path: string, allowed: readonly string[], what: string): YadbeError | null {
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
    return mockErrors.invalidArgument(
      'The file path must be absolute.',
      'Le chemin du fichier doit être absolu.',
    );
  }
  const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  if (!allowed.includes(extension)) {
    const list = allowed.join(', ');
    return mockErrors.invalidArgument(
      `${what} must be one of these file types: ${list}.`,
      `${what} doit être de l'un de ces types de fichier : ${list}.`,
    );
  }
  return null;
}

const shown = (value: string): string =>
  Array.from(value).length > VALUE_CHARS
    ? `${Array.from(value).slice(0, VALUE_CHARS).join('')}…`
    : value;

const isError = (value: object): value is YadbeError => 'code' in value && 'message' in value;

function targetColumns(details: TableDetails): ImportTargetColumn[] {
  return details.columns.map((c) => ({
    name: c.name,
    typeName: c.typeName,
    kind: c.kind,
    nullable: c.nullable,
    filledByServer: c.default !== null || c.identity !== null || c.generated !== null,
    primaryKey: c.primaryKey,
    readOnlyReason: c.generated ? 'generated' : c.identity === 'always' ? 'identity' : null,
  }));
}

function maxBatchRows(engine: Engine, columns: number): number {
  const parameters = engine === 'mssql' ? 2000 : 30_000;
  return Math.max(1, Math.min(1000, Math.floor(parameters / Math.max(1, columns))));
}

interface Prepared {
  details: TableDetails;
  engine: Engine;
  columns: ImportTargetColumn[];
  parsed: MockParsed;
  /** The mapped columns read from the file, with their position in a record. */
  fileColumns: { column: ImportTargetColumn; index: number }[];
  missingRequired: string[];
}

/** The same checks as `plan::build`, then the parsed file. */
function prepare(host: MockImportHost, request: ImportRequest): Prepared | YadbeError {
  const filePath = pathProblem(request.path, IMPORT_EXTENSIONS, 'An import file');
  if (filePath) return filePath;
  const session = host.session(request.connectionId);
  if (!session) return mockErrors.notConnected();
  const relation = host.relation(request.connectionId, request.table);
  if (!relation) return mockErrors.objectNotFound(request.table.name);
  const text = host.readFile(request.path);
  if (text === undefined) return mockErrors.fileNotFound(request.path);
  let parsed: MockParsed;
  try {
    parsed = readFile(text, request.parse);
  } catch (error) {
    if (error instanceof MockParseError) {
      return mockErrors.importFileInvalid(error.line, error.problem);
    }
    throw error;
  }
  const { details } = relation;
  if (details.kind !== 'table') {
    return mockErrors.tableNotEditable(
      'Rows can only be imported into a table, not a view.',
      'Des lignes ne peuvent être importées que dans une table, pas dans une vue.',
    );
  }
  if (request.mapping.length === 0) {
    return mockErrors.invalidArgument('Map at least one column.', 'Associez au moins une colonne.');
  }
  const columns = targetColumns(details);
  const fileColumns: Prepared['fileColumns'] = [];
  const seen = new Set<string>();
  for (const mapping of request.mapping) {
    const column = columns.find((c) => c.name === mapping.column);
    if (!column) {
      return mockErrors.invalidArgument(
        `The table has no column "${mapping.column}".`,
        `La table n'a pas de colonne « ${mapping.column} ».`,
      );
    }
    if (column.readOnlyReason !== null) {
      return mockErrors.invalidArgument(
        `The column "${column.name}" cannot be written (${column.readOnlyReason}).`,
        `La colonne « ${column.name} » ne peut pas être écrite (${column.readOnlyReason}).`,
      );
    }
    if (seen.has(column.name)) {
      return mockErrors.invalidArgument(
        `The column "${column.name}" is mapped twice.`,
        `La colonne « ${column.name} » est associée deux fois.`,
      );
    }
    seen.add(column.name);
    const source = mapping.source;
    if (source.kind === 'file') {
      if (source.index >= parsed.columns.length) {
        return mockErrors.invalidArgument(
          `The file has no column number ${source.index + 1}.`,
          `Le fichier n'a pas de colonne numéro ${source.index + 1}.`,
        );
      }
      fileColumns.push({ column, index: source.index });
    } else if (source.kind === 'null' && !column.nullable) {
      return mockErrors.invalidArgument(
        `The column "${column.name}" does not accept NULL.`,
        `La colonne « ${column.name} » n'accepte pas NULL.`,
      );
    } else if (source.kind === 'constant') {
      const issue = checkCell(column, source.value, request.convert);
      if (issue) {
        return mockErrors.invalidArgument(
          `The constant for "${column.name}" is not a valid value of its type (${issue}).`,
          `La constante de « ${column.name} » n'est pas une valeur valide pour son type (${issue}).`,
        );
      }
    }
  }
  const missingRequired = columns
    .filter((c) => !c.nullable && !c.filledByServer && !seen.has(c.name))
    .map((c) => c.name);
  return { details, engine: session.engine, columns, parsed, fileColumns, missingRequired };
}

function analysisOf(prepared: Prepared): ImportAnalysis {
  const checks: ImportColumnCheck[] = prepared.fileColumns.map(({ column }) => ({
    column: column.name,
    typeName: column.typeName,
    kind: column.kind,
    nullable: column.nullable,
    examined: 0,
    nulls: 0,
    invalid: 0,
    samples: [],
  }));
  return { rowsExamined: 0, sampled: false, raggedRows: 0, columns: checks, missingRequired: [] };
}

/** Imports of the mock backend: the contract of `import/`, simulated on the mock disk. */
export function createMockImport(host: MockImportHost) {
  let nextId = 1;
  let tick = DEFAULT_TICK_MS;
  const jobs = new Map<number, AbortController>();

  async function run(
    importId: number,
    request: ImportRequest,
    prepared: Prepared,
    signal: AbortSignal,
  ): Promise<void> {
    const started = performance.now();
    const options = request.convert;
    const { parsed, fileColumns, columns } = prepared;
    const table = request.table.name;
    const columnList = request.mapping.map((m) => m.column).join(', ');
    const batchRows = maxBatchRows(prepared.engine, request.mapping.length);
    const total = parsed.records.length;
    const keys = columns.filter((c) => c.primaryKey);
    const seenKeys = new Set<string>();
    const rejects: ImportReject[] = [];
    const rejectLines: string[] = [];
    let rejected = 0;
    let inserted = 0;
    let batches = 0;
    let kept = 0;
    let error: YadbeError | null = null;
    let cancelled = false;
    const transactional = request.dryRun || request.commit === 'single';
    if (transactional) host.logStatement(request.connectionId, 'BEGIN');
    const columnIndex = new Map(fileColumns.map(({ column, index }) => [column.name, index]));

    const reject = (record: (typeof parsed.records)[number], item: ImportReject) => {
      rejected++;
      if (rejects.length < SAMPLE_REJECTS) rejects.push(item);
      const cells = record.cells.map((c) =>
        c === null ? '' : /[",\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c,
      );
      rejectLines.push(
        `${record.line},"${item.reason}${item.detail ? `: ${item.detail}` : ''}",${cells.join(',')}`,
      );
    };

    scan: for (let from = 0; from < total; from += STEP_ROWS) {
      if (signal.aborted) {
        cancelled = true;
        break;
      }
      const slice = parsed.records.slice(from, from + STEP_ROWS);
      for (const record of slice) {
        if (record.ragged !== null) {
          reject(record, {
            line: record.line,
            column: null,
            value: String(record.ragged),
            reason: 'fieldCount',
            detail: null,
          });
        } else {
          let issue: ImportReject | null = null;
          for (const { column, index } of fileColumns) {
            const kind = checkCell(column, record.cells[index] ?? null, options);
            if (kind) {
              const cell = record.cells[index] ?? null;
              issue = {
                line: record.line,
                column: column.name,
                value: cell === null ? null : shown(cell),
                reason: kind,
                detail: null,
              };
              break;
            }
          }
          if (!issue && keys.length > 0 && keys.every((k) => columnIndex.has(k.name))) {
            const key = keys
              .map((k) => record.cells[columnIndex.get(k.name) ?? 0] ?? '')
              .join('\u0001');
            if (seenKeys.has(key)) {
              issue = {
                line: record.line,
                column: keys[0]?.name ?? null,
                value: null,
                reason: 'constraint',
                detail: `duplicate key value violates unique constraint "${table}_pkey"`,
              };
            } else seenKeys.add(key);
          }
          if (!issue) {
            inserted++;
            continue;
          }
          reject(record, issue);
          if (request.onError === 'stop') {
            error = mockErrors.importRejected(
              record.line,
              `${issue.column ?? ''}: ${issue.reason}${issue.value ? ` (${issue.value})` : ''}`,
            );
            break scan;
          }
          continue;
        }
        if (request.onError === 'stop') {
          error = mockErrors.importRejected(record.line, `fieldCount (${record.ragged} fields)`);
          break scan;
        }
      }
      const rowsHere = slice.length;
      const logged = Math.ceil(rowsHere / batchRows);
      for (let b = 0; b < logged; b++) {
        batches++;
        host.logStatement(
          request.connectionId,
          `INSERT INTO ${table} (${columnList}) VALUES (…) /* import: ${Math.min(batchRows, rowsHere - b * batchRows)} rows, batch ${batches} */`,
        );
      }
      if (request.commit === 'perBatch' && !request.dryRun) kept = inserted;
      if (from + STEP_ROWS < total) {
        host.events.emit('importProgress', {
          importId,
          rowsRead: from + slice.length,
          inserted,
          rejected,
          bytesRead: Math.round(
            ((from + slice.length) / total) * (host.readFile(request.path)?.length ?? 0),
          ),
          totalBytes: host.readFile(request.path)?.length ?? 0,
        });
        await new Promise((resolve) => setTimeout(resolve, tick));
      }
    }
    jobs.delete(importId);
    if (signal.aborted) cancelled = true;
    const failed = error !== null;
    if (!failed && !cancelled && !request.dryRun) kept = inserted;
    if (transactional) {
      host.logStatement(
        request.connectionId,
        failed || cancelled || request.dryRun ? 'ROLLBACK' : 'COMMIT',
      );
      if (failed || cancelled || request.dryRun) kept = 0;
    }
    const done = !failed && !cancelled;
    let rejectsPath: string | null = null;
    if (done && request.rejectsPath) {
      host.writeFile(
        request.rejectsPath,
        `line,error,${parsed.columns.join(',')}\n${rejectLines.join('\n')}${rejectLines.length ? '\n' : ''}`,
      );
      rejectsPath = request.rejectsPath;
    }
    if (kept > 0) {
      host.events.emit('tableDataChanged', {
        connectionId: request.connectionId,
        table: request.table,
        tabId: '',
        updated: 0,
        inserted: kept,
        deleted: 0,
      });
    }
    const finished: ImportFinished = {
      importId,
      status: cancelled ? 'cancelled' : failed ? 'failed' : 'done',
      dryRun: request.dryRun,
      commit: request.commit,
      rowsRead: failed ? inserted + rejected : total,
      inserted,
      kept,
      rejected,
      batches,
      durationMs: Math.round(performance.now() - started),
      rejectSamples: rejects,
      rejectsPath,
      invalidBytes: 0,
      droppedKeys: 0,
      error,
    };
    host.events.emit('importFinished', finished);
  }

  const commands: ImportCommands = {
    previewImportFile: (path, options, limit) => {
      const problem = pathProblem(path, IMPORT_EXTENSIONS, 'An import file');
      if (problem) return fail(problem);
      const text = host.readFile(path);
      if (text === undefined) return fail(mockErrors.fileNotFound(path));
      const detected = detectOptions(text, path);
      const effective = options ?? detected.options;
      try {
        const parsed = readFile(text, effective);
        return ok({
          options: effective,
          bom: detected.bom,
          fileSize: text.length,
          columns: parsed.columns,
          rows: parsed.records.slice(0, Math.min(limit, MAX_PREVIEW_ROWS)).map((r) => r.cells),
          raggedRows: parsed.records
            .slice(0, Math.min(limit, MAX_PREVIEW_ROWS))
            .filter((r) => r.ragged !== null).length,
          invalidBytes: 0,
        });
      } catch (error) {
        if (error instanceof MockParseError) {
          return fail(mockErrors.importFileInvalid(error.line, error.problem));
        }
        throw error;
      }
    },

    getImportTarget: (connectionId, table): Result<ImportTarget> => {
      const session = host.session(connectionId);
      if (!session) return fail(mockErrors.notConnected());
      const relation = host.relation(connectionId, table);
      if (!relation) return fail(mockErrors.objectNotFound(table.name));
      const columns = targetColumns(relation.details);
      return ok({
        table: relation.details.table,
        columns,
        readOnly: session.readOnly,
        maxBatchRows: maxBatchRows(session.engine, columns.length),
      });
    },

    analyzeImport: (request) => {
      const prepared = prepare(host, request);
      if (isError(prepared)) return fail(prepared);
      const analysis = analysisOf(prepared);
      const rows = prepared.parsed.records.slice(0, ANALYZE_ROWS);
      analysis.rowsExamined = rows.length;
      analysis.sampled = prepared.parsed.records.length > ANALYZE_ROWS;
      analysis.missingRequired = prepared.missingRequired;
      for (const record of rows) {
        if (record.ragged !== null) analysis.raggedRows++;
        prepared.fileColumns.forEach(({ column, index }, at) => {
          const check = analysis.columns[at];
          if (!check) return;
          const cell = record.cells[index] ?? null;
          check.examined++;
          if (cell === null) check.nulls++;
          const reason = checkCell(column, cell, request.convert);
          if (reason) {
            check.invalid++;
            if (check.samples.length < 5) {
              check.samples.push({
                line: record.line,
                value: cell === null ? '' : shown(cell),
                reason,
              });
            }
          }
        });
      }
      return ok(analysis);
    },

    startImport: (request) => {
      const session = host.session(request.connectionId);
      if (session?.readOnly) return fail(mockErrors.readOnlyViolation('INSERT'));
      const rejectsProblem =
        request.rejectsPath === null
          ? null
          : pathProblem(request.rejectsPath, REJECTS_EXTENSIONS, 'The file of rejected rows');
      if (rejectsProblem) return fail(rejectsProblem);
      const prepared = prepare(host, request);
      if (isError(prepared)) return fail(prepared);
      if (prepared.missingRequired.length > 0) {
        const list = prepared.missingRequired.join(', ');
        return fail(
          mockErrors.invalidArgument(
            `These columns need a value and have no default: ${list}.`,
            `Ces colonnes exigent une valeur et n'ont pas de valeur par défaut : ${list}.`,
          ),
        );
      }
      const importId = nextId++;
      const controller = new AbortController();
      jobs.set(importId, controller);
      setTimeout(() => {
        void run(importId, request, prepared, controller.signal);
      }, 0);
      return ok({ importId });
    },

    cancelImport: (importId) => {
      jobs.get(importId)?.abort();
      return ok(null);
    },
  };

  return {
    commands,
    /** Time between two simulated steps of an import, in ms (0 in unit tests). */
    setTick(ms: number): void {
      tick = ms;
    },
    reset(): void {
      for (const job of jobs.values()) job.abort();
      jobs.clear();
      tick = DEFAULT_TICK_MS;
      nextId = 1;
    },
  };
}
