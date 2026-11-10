import type { YadbeError } from './bindings';
import type { YadbeCommands } from './client';
import { mockErrors } from './mockErrors';

type FileCommands = Pick<YadbeCommands, 'readTextFile' | 'writeTextFile' | 'writeValueFile'>;

type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

const ok = <T>(data: T): Result<T> => Promise.resolve({ status: 'ok', data });
const fail = <T>(error: YadbeError): Result<T> => Promise.resolve({ status: 'error', error });

/** Extensions the backend serves (`commands/files.rs`). */
const SCRIPT_EXTENSIONS = ['sql', 'ddl', 'dml', 'psql', 'pgsql', 'tsql', 'txt'];

/** Extensions a cell value can be saved as (`commands/value_file.rs`). */
const DATA_EXTENSIONS = [
  ...['txt', 'json', 'xml', 'bin', 'dat', 'csv', 'tsv', 'sql', 'html', 'svg'],
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'zip', 'gz'],
];

/** Scripts the mock "disk" starts with: something to open without picking a file. */
const SEED: Record<string, string> = {
  '/home/ana/queries/orders-report.sql': `-- Orders of the last week, with their customer
select o.id, o.total, c.email
from orders o
join customers c on c.id = o.customer_id
where o.created_at > now() - interval '7 days'
order by o.created_at desc;
`,
  '/home/ana/queries/cleanup.sql': `delete from sessions where expires_at < now();
vacuum analyze sessions;
`,
};

function pathProblem(path: string, extensions = SCRIPT_EXTENSIONS): YadbeError | null {
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
    return mockErrors.invalidArgument(
      'The file path must be absolute.',
      'Le chemin du fichier doit être absolu.',
    );
  }
  const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  if (!extensions.includes(extension)) {
    const list = extensions.join(', ');
    if (extensions === DATA_EXTENSIONS) {
      return mockErrors.invalidArgument(
        `A value can only be saved as one of these file types: ${list}.`,
        `Une valeur ne peut être enregistrée que dans l'un de ces types de fichier : ${list}.`,
      );
    }
    return mockErrors.invalidArgument(
      `Only script files can be opened or saved here (${list}).`,
      `Seuls les fichiers de script peuvent être ouverts ou enregistrés ici (${list}).`,
    );
  }
  return null;
}

/** An in-memory disk for the script files of the editor (F-045). */
export function createMockFiles() {
  const files = new Map<string, string>(Object.entries(SEED));

  const commands: FileCommands = {
    readTextFile: (path) => {
      const problem = pathProblem(path);
      if (problem) return fail(problem);
      const text = files.get(path);
      return text === undefined ? fail(mockErrors.fileNotFound(path)) : ok(text);
    },
    writeTextFile: (path, text) => {
      const problem = pathProblem(path);
      if (problem) return fail(problem);
      files.set(path, text);
      return ok(null);
    },
    writeValueFile: (path, contents, encoding) => {
      const problem = pathProblem(path, DATA_EXTENSIONS);
      if (problem) return fail(problem);
      if (encoding === 'hex' && !/^(?:[0-9a-fA-F]{2})*$/.test(contents)) {
        return fail(
          mockErrors.invalidArgument(
            'The binary value is not valid hexadecimal.',
            "La valeur binaire n'est pas un hexadécimal valide.",
          ),
        );
      }
      // The mock disk holds text: binary files keep their hexadecimal form.
      files.set(path, contents);
      return ok(null);
    },
  };

  return {
    commands,
    /** Puts a file on the mock disk, or removes it with `null` (tests: change it behind the app). */
    set(path: string, text: string | null): void {
      if (text === null) files.delete(path);
      else files.set(path, text);
    },
    get(path: string): string | undefined {
      return files.get(path);
    },
    reset(): void {
      files.clear();
      for (const [path, text] of Object.entries(SEED)) files.set(path, text);
    },
  };
}
