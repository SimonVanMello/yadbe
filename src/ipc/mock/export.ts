import type {
  ColumnMeta,
  ExportFormat,
  ExportScope,
  ExportSourceSpec,
  Value,
  YadbeError,
} from '../bindings';
import type { YadbeCommands } from '../client';
import type { EventEmitter } from '../emitter';
import { mockErrors } from '../mockErrors';
import type { MockResultSource } from '../mockQuery';
import { mockEncoder } from './exportFormat';

type ExportCommands = Pick<YadbeCommands, 'startExport' | 'cancelExport' | 'previewExport'>;

type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

const ok = <T>(data: T): Result<T> => Promise.resolve({ status: 'ok', data });
const fail = <T>(error: YadbeError): Result<T> => Promise.resolve({ status: 'error', error });

/** Extensions each format may be saved as (`export/manager.rs`). */
const EXTENSIONS = {
  csv: ['csv', 'tsv', 'txt'],
  json: ['json', 'ndjson', 'jsonl', 'txt'],
} as const;

const BOM = String.fromCharCode(0xfeff);
const stripBom = (text: string) => (text.startsWith(BOM) ? text.slice(1) : text);

const DEFAULT_TICK_MS = 40;
/** Rows written per simulated step. */
const STEP_ROWS = 20_000;
const MAX_PREVIEW_ROWS = 100;

export interface MockExportHost {
  events: EventEmitter;
  source(resultId: number): MockResultSource | undefined;
  /** Puts the finished file on the mock disk. */
  writeFile(path: string, text: string): void;
}

function pathProblem(path: string, format: ExportFormat): YadbeError | null {
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
    return mockErrors.invalidArgument(
      'The file path must be absolute.',
      'Le chemin du fichier doit être absolu.',
    );
  }
  const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  const allowed: readonly string[] = EXTENSIONS[format.format];
  if (!allowed.includes(extension)) {
    const list = allowed.join(', ');
    return mockErrors.invalidArgument(
      `This format can only be saved as one of these file types: ${list}.`,
      `Ce format ne peut être enregistré que dans l'un de ces types de fichier : ${list}.`,
    );
  }
  return null;
}

interface Selection {
  rows: [number, number];
  columns: number[] | null;
  /** The rows a statement past its limit would still send. */
  total: number;
}

function selection(source: MockResultSource, scope: ExportScope): Selection | YadbeError {
  if (scope.kind === 'all') {
    return { rows: [0, source.total], columns: null, total: source.total };
  }
  if (
    scope.rowFrom > scope.rowTo ||
    scope.columns.length === 0 ||
    scope.columns.some((column) => column >= source.columns.length)
  ) {
    return mockErrors.invalidArgument(
      'The selection is outside the result.',
      'La sélection est hors du résultat.',
    );
  }
  const end = Math.min(scope.rowTo + 1, source.loaded);
  return { rows: [Math.min(scope.rowFrom, end), end], columns: scope.columns, total: end };
}

const isError = (value: Selection | YadbeError): value is YadbeError => 'code' in value;

function rowOf(source: MockResultSource, row: number, columns: number[] | null): Value[] {
  const indexes = columns ?? source.columns.map((_, i) => i);
  return indexes.map((c) => source.value(row, c));
}

function columnsOf(source: MockResultSource, columns: number[] | null): ColumnMeta[] {
  return columns ? columns.flatMap((c) => source.columns[c] ?? []) : source.columns;
}

/** Exports of the mock backend: the same contract as `export/`, written to the mock disk. */
export function createMockExport(host: MockExportHost) {
  let nextId = 1;
  let tick = DEFAULT_TICK_MS;
  const jobs = new Map<number, AbortController>();

  async function run(
    exportId: number,
    source: MockResultSource,
    picked: Selection,
    format: ExportFormat,
    path: string,
    signal: AbortSignal,
  ): Promise<void> {
    const encoder = mockEncoder(format);
    const parts: string[] = [encoder.begin(columnsOf(source, picked.columns))];
    let bytes = parts[0]?.length ?? 0;
    const [from, to] = picked.rows;
    let lastEmit = 0;
    for (let row = from; row < to; row++) {
      const text = encoder.row(rowOf(source, row, picked.columns));
      parts.push(text);
      bytes += text.length;
      const written = row + 1 - from;
      if (written % STEP_ROWS === 0 && row + 1 < to) {
        await new Promise((resolve) => setTimeout(resolve, tick));
        if (signal.aborted) break;
        if (performance.now() - lastEmit >= 100) {
          lastEmit = performance.now();
          host.events.emit('exportProgress', { exportId, rows: written, bytes });
        }
      }
    }
    jobs.delete(exportId);
    if (signal.aborted) {
      host.events.emit('exportFinished', {
        exportId,
        status: 'cancelled',
        rows: 0,
        bytes: 0,
        path,
        truncated: false,
        error: null,
      });
      return;
    }
    const tail = encoder.end();
    parts.push(tail);
    bytes += tail.length;
    host.writeFile(path, parts.join(''));
    host.events.emit('exportFinished', {
      exportId,
      status: 'done',
      rows: Math.max(0, to - from),
      bytes,
      path,
      truncated: false,
      error: null,
    });
  }

  const commands: ExportCommands = {
    startExport: (request) => {
      const problem = pathProblem(request.path, request.format);
      if (problem) return fail(problem);
      const spec = request.source;
      const source = host.source(spec.resultId);
      if (!source) return fail(mockErrors.resultNotFound(spec.resultId));
      const picked = selection(source, spec.scope);
      if (isError(picked)) return fail(picked);
      const exportId = nextId++;
      const controller = new AbortController();
      jobs.set(exportId, controller);
      // Started after the call returns, like the backend's background job.
      setTimeout(() => {
        void run(exportId, source, picked, request.format, request.path, controller.signal);
      }, 0);
      return ok({ exportId });
    },

    cancelExport: (exportId) => {
      jobs.get(exportId)?.abort();
      return ok(null);
    },

    previewExport: (spec: ExportSourceSpec, format, limit) => {
      const source = host.source(spec.resultId);
      if (!source) return fail(mockErrors.resultNotFound(spec.resultId));
      const picked = selection(source, spec.scope);
      if (isError(picked)) return fail(picked);
      const encoder = mockEncoder(format);
      const [from, to] = picked.rows;
      const end = Math.min(to, source.loaded, from + Math.min(limit, MAX_PREVIEW_ROWS));
      let text = stripBom(encoder.begin(columnsOf(source, picked.columns)));
      for (let row = from; row < end; row++) {
        text += encoder.row(rowOf(source, row, picked.columns));
      }
      return ok(text + encoder.end());
    },
  };

  return {
    commands,
    /** Time between two simulated steps of an export, in ms (0 in unit tests). */
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
