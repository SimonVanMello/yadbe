import type {
  FolderDeletion,
  ImportReport,
  NewSavedQuery,
  QueryFolder,
  SavedConnection,
  SavedQuery,
  SavedQueryLibrary,
  SavedQueryUpdate,
  SnippetDefinition,
  YadbeError,
} from '../bindings';
import type { YadbeClient } from '../client';
import type { EventEmitter } from '../emitter';
import { mockErrors } from '../mockErrors';

type Commands = YadbeClient['commands'];
type Result<T> = Promise<{ status: 'ok'; data: T } | { status: 'error'; error: YadbeError }>;

/** The library commands the mock implements. */
export type SavedQueryCommands = Pick<
  Commands,
  | 'listSavedQueries'
  | 'getSavedQuery'
  | 'searchSavedQueries'
  | 'listSnippets'
  | 'createSavedQuery'
  | 'updateSavedQuery'
  | 'moveSavedQuery'
  | 'duplicateSavedQuery'
  | 'deleteSavedQuery'
  | 'touchSavedQuery'
  | 'createQueryFolder'
  | 'renameQueryFolder'
  | 'moveQueryFolder'
  | 'deleteQueryFolder'
  | 'exportSavedQueries'
  | 'importSavedQueries'
>;

/** What the library mock needs from the rest of the mock backend. */
export interface SavedQueryDeps {
  events: EventEmitter;
  connection(id: string): SavedConnection | undefined;
  /** The mock disk (import and export). */
  files: { get(path: string): string | undefined; set(path: string, text: string | null): void };
}

// The same bounds as the backend (`store/saved_queries.rs`).
const MAX_NAME = 120;
const MAX_FOLDER_NAME = 60;
const MAX_DESCRIPTION = 2000;
const MAX_SQL = 1024 * 1024;
const MAX_TAGS = 12;
const MAX_TAG = 32;
const MAX_TRIGGER = 32;
const MAX_DEPTH = 8;
const PREVIEW_CHARS = 400;
const SEARCH_LIMIT = 200;
const FORMAT = 'yadbe-library';

const DAY = 86_400;
/** Fixed seed times keep captures and tests deterministic (Unix seconds). */
const SEED_AT = 1_762_000_000;

function ok<T>(data: T): Result<T> {
  return Promise.resolve({ status: 'ok', data });
}

function fail<T>(error: YadbeError): Result<T> {
  return Promise.resolve({ status: 'error', error });
}

const invalid = (en: string, fr: string): YadbeError => mockErrors.invalidArgument(en, fr);

const seconds = (): number => Math.floor(Date.now() / 1000);

type Stored = Omit<SavedQuery, 'sqlTruncated'>;

interface Seed {
  name: string;
  sql: string;
  folder?: string;
  connection?: string;
  database?: string;
  description?: string;
  tags?: string[];
  trigger?: string;
  usedDaysAgo?: number;
}

const FOLDERS: { id: string; name: string; parent: string | null }[] = [
  { id: 'sqf-reports', name: 'Reports', parent: null },
  { id: 'sqf-monthly', name: 'Monthly', parent: 'sqf-reports' },
  { id: 'sqf-maintenance', name: 'Maintenance', parent: null },
  { id: 'sqf-debug', name: 'Debugging', parent: null },
];

const SEEDS: Seed[] = [
  {
    name: 'Orders of the last week',
    folder: 'sqf-reports',
    connection: 'conn-local-pg',
    database: 'app_dev',
    description: 'Orders with their customer, newest first.',
    tags: ['orders', 'weekly'],
    usedDaysAgo: 1,
    sql: `SELECT o.id, o.total, c.email
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.created_at > now() - interval '7 days'
ORDER BY o.created_at DESC;`,
  },
  {
    name: 'Revenue per month',
    folder: 'sqf-monthly',
    description: 'Total revenue grouped by month, for the finance report.',
    tags: ['revenue', 'finance'],
    usedDaysAgo: 3,
    sql: `SELECT date_trunc('month', created_at) AS month, sum(total) AS revenue
FROM orders
GROUP BY 1
ORDER BY 1 DESC;`,
  },
  {
    name: 'Top 20 products by units sold',
    folder: 'sqf-monthly',
    connection: 'conn-local-pg',
    description: 'Best sellers.',
    tags: ['products'],
    sql: `SELECT p.name, sum(i.quantity) AS sold
FROM order_items i
JOIN products p ON p.id = i.product_id
GROUP BY p.name
ORDER BY sold DESC
LIMIT 20;`,
  },
  {
    name: 'Stock below threshold',
    folder: 'sqf-reports',
    connection: 'conn-reporting',
    database: 'Reporting',
    sql: `SELECT TOP 100 sku, name, stock
FROM products
WHERE stock < 5
ORDER BY stock;`,
  },
  {
    name: 'Clean expired sessions',
    folder: 'sqf-maintenance',
    description: 'Run on staging first: deletes every expired session.',
    tags: ['cleanup'],
    usedDaysAgo: 10,
    sql: `DELETE FROM sessions WHERE expires_at < now();
VACUUM ANALYZE sessions;`,
  },
  {
    name: 'Table sizes',
    folder: 'sqf-maintenance',
    connection: 'conn-local-pg',
    tags: ['size'],
    sql: `SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS size
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 20;`,
  },
  {
    name: 'Blocking sessions',
    folder: 'sqf-debug',
    connection: 'conn-local-pg',
    description: 'Who waits for whom.',
    sql: `SELECT blocked.pid AS blocked, blocking.pid AS blocking, blocked.query
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking ON blocking.pid = ANY (pg_blocking_pids(blocked.pid));`,
  },
  {
    name: 'Customers without orders',
    description: 'Anti-join, the way that uses the index.',
    sql: `SELECT c.id, c.email
FROM customers c
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);`,
    usedDaysAgo: 0,
  },
  {
    name: 'Duplicate emails',
    sql: `SELECT email, count(*) AS n
FROM customers
GROUP BY email
HAVING count(*) > 1;`,
  },
  {
    name: 'Last rows of a table',
    description: 'Snippet: type lastrows, then Tab to move between the fields.',
    tags: ['snippet'],
    trigger: 'lastrows',
    sql: 'SELECT *\nFROM ${1:table}\nORDER BY ${2:id} DESC\nLIMIT ${3:50};',
  },
  {
    name: 'Rows created today',
    description: 'Snippet with the current date.',
    tags: ['snippet'],
    trigger: 'today',
    sql: "SELECT *\nFROM ${1:table}\nWHERE created_at >= '${date}';",
  },
];

/** A saved-query library, in memory. */
export function createMockSavedQueries(deps: SavedQueryDeps) {
  let folders: QueryFolder[] = [];
  let queries: Stored[] = [];
  let counter = 0;

  function seed(): void {
    counter = 0;
    folders = FOLDERS.map((folder) => ({
      id: folder.id,
      name: folder.name,
      parentId: folder.parent,
      createdAt: SEED_AT,
    }));
    queries = SEEDS.map((entry, index) => ({
      id: `sq-seed-${String(index + 1)}`,
      folderId: entry.folder ?? null,
      name: entry.name,
      sql: entry.sql,
      description: entry.description ?? '',
      tags: entry.tags ?? [],
      connectionId: entry.connection ?? null,
      database: entry.connection ? (entry.database ?? null) : null,
      snippetTrigger: entry.trigger ?? null,
      createdAt: SEED_AT + index * 60,
      updatedAt: SEED_AT + index * 60,
      lastUsedAt:
        entry.usedDaysAgo === undefined ? null : SEED_AT + 30 * DAY - entry.usedDaysAgo * DAY,
    }));
  }

  const announce = (): void => {
    deps.events.emit('savedQueriesChanged', {});
  };

  const listRow = (query: Stored): SavedQuery => {
    const chars = Array.from(query.sql);
    const truncated = chars.length > PREVIEW_CHARS;
    return {
      ...query,
      sql: truncated ? chars.slice(0, PREVIEW_CHARS).join('') : query.sql,
      sqlTruncated: truncated,
    };
  };

  const whole = (query: Stored): SavedQuery => ({ ...query, sqlTruncated: false });

  const find = (id: string): Stored | undefined => queries.find((q) => q.id === id);

  function depthOf(folderId: string | null): number {
    let depth = 0;
    let cursor = folderId;
    while (cursor !== null && depth <= MAX_DEPTH * 4) {
      depth += 1;
      cursor = folders.find((f) => f.id === cursor)?.parentId ?? null;
    }
    return depth;
  }

  function heightOf(folderId: string): number {
    let tallest = 0;
    for (const child of folders.filter((f) => f.parentId === folderId)) {
      tallest = Math.max(tallest, heightOf(child.id));
    }
    return tallest + 1;
  }

  function descendants(folderId: string): string[] {
    const ids = [folderId];
    for (const child of folders.filter((f) => f.parentId === folderId)) {
      ids.push(...descendants(child.id));
    }
    return ids;
  }

  const folderProblem = (folderId: string | null): YadbeError | null =>
    folderId !== null && !folders.some((f) => f.id === folderId)
      ? mockErrors.queryFolderNotFound(folderId)
      : null;

  function connectionProblem(connectionId: string | null): YadbeError | null {
    return connectionId !== null && !deps.connection(connectionId)
      ? mockErrors.connectionNotFound(connectionId)
      : null;
  }

  function checkedName(name: string, max: number, en: string, fr: string): string | YadbeError {
    const trimmed = name.trim();
    if (trimmed === '') return invalid(`${en} needs a name.`, `${fr} doit avoir un nom.`);
    if (Array.from(trimmed).length > max) {
      return invalid(
        `${en} name has at most ${String(max)} characters.`,
        `Le nom de ${fr} compte au plus ${String(max)} caractères.`,
      );
    }
    return trimmed;
  }

  function checkedTags(tags: string[]): string[] | YadbeError {
    const clean: string[] = [];
    for (const raw of tags) {
      const tag = raw.trim();
      if (tag === '' || clean.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
      if (Array.from(tag).length > MAX_TAG) {
        return invalid(
          `A tag has at most ${String(MAX_TAG)} characters.`,
          `Une étiquette compte au plus ${String(MAX_TAG)} caractères.`,
        );
      }
      clean.push(tag);
    }
    if (clean.length > MAX_TAGS) {
      return invalid(
        `A query has at most ${String(MAX_TAGS)} tags.`,
        `Une requête a au plus ${String(MAX_TAGS)} étiquettes.`,
      );
    }
    return clean;
  }

  function checkedTrigger(trigger: string | null): string | null | YadbeError {
    const trimmed = trigger?.trim() ?? '';
    if (trimmed === '') return null;
    if (trimmed.length > MAX_TRIGGER || !/^[A-Za-z][A-Za-z0-9_]*$/.test(trimmed)) {
      return invalid(
        `A trigger word is made of letters, digits and _, starts with a letter and has at most ${String(MAX_TRIGGER)} characters.`,
        `Un mot déclencheur est fait de lettres, de chiffres et de _, commence par une lettre et compte au plus ${String(MAX_TRIGGER)} caractères.`,
      );
    }
    return trimmed;
  }

  const isError = (value: unknown): value is YadbeError =>
    typeof value === 'object' && value !== null && 'code' in value && 'message' in value;

  /** Validates the fields shared by a new query and an update. */
  function checkedFields(
    fields: Pick<
      NewSavedQuery,
      'name' | 'description' | 'tags' | 'folderId' | 'snippetTrigger' | 'connectionId'
    >,
    connectionChanged: boolean,
  ): { name: string; description: string; tags: string[]; trigger: string | null } | YadbeError {
    const name = checkedName(fields.name, MAX_NAME, 'A query', 'la requête');
    if (isError(name)) return name;
    if (Array.from(fields.description).length > MAX_DESCRIPTION) {
      return invalid(
        `A description has at most ${String(MAX_DESCRIPTION)} characters.`,
        `Une description compte au plus ${String(MAX_DESCRIPTION)} caractères.`,
      );
    }
    const tags = checkedTags(fields.tags);
    if (isError(tags)) return tags;
    const trigger = checkedTrigger(fields.snippetTrigger);
    if (isError(trigger)) return trigger;
    const problem =
      folderProblem(fields.folderId) ??
      (connectionChanged ? connectionProblem(fields.connectionId) : null);
    if (problem) return problem;
    return { name, description: fields.description.trim(), tags, trigger };
  }

  const tooLarge = (sql: string): YadbeError | null =>
    new TextEncoder().encode(sql).length > MAX_SQL
      ? invalid(
          'This statement is too large to be saved in the library.',
          'Cette instruction est trop volumineuse pour la bibliothèque.',
        )
      : null;

  function insert(fields: NewSavedQuery): Stored | YadbeError {
    const big = tooLarge(fields.sql);
    if (big) return big;
    const checked = checkedFields(fields, true);
    if (isError(checked)) return checked;
    counter += 1;
    const at = seconds();
    const stored: Stored = {
      id: `sq-${String(counter)}`,
      folderId: fields.folderId,
      name: checked.name,
      sql: fields.sql,
      description: checked.description,
      tags: checked.tags,
      connectionId: fields.connectionId,
      database: fields.connectionId ? (fields.database?.trim() ?? '') || null : null,
      snippetTrigger: checked.trigger,
      createdAt: at,
      updatedAt: at,
      lastUsedAt: null,
    };
    queries.push(stored);
    return stored;
  }

  const tokens = (text: string): string[] =>
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);

  /** Like the backend's FTS5 search: every word of the query starts a word, name ranks first. */
  function search(text: string, connectionId: string | null): string[] {
    const needles = tokens(text).slice(0, 12);
    if (needles.length === 0) return [];
    const scored: { id: string; score: number }[] = [];
    for (const query of queries) {
      if (
        connectionId !== null &&
        query.connectionId !== null &&
        query.connectionId !== connectionId
      ) {
        continue;
      }
      const columns = [
        { words: tokens(query.name), weight: 8 },
        { words: tokens(query.tags.join(' ')), weight: 4 },
        { words: tokens(query.description), weight: 3 },
        { words: tokens(query.sql), weight: 1 },
      ];
      let score = 0;
      const every = needles.every((needle) => {
        let best = 0;
        for (const column of columns) {
          if (column.words.some((word) => word.startsWith(needle))) {
            best = Math.max(best, column.weight);
          }
        }
        score += best;
        return best > 0;
      });
      if (every) scored.push({ id: query.id, score });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, SEARCH_LIMIT)
      .map((hit) => hit.id);
  }

  const commands: SavedQueryCommands = {
    listSavedQueries: () =>
      ok<SavedQueryLibrary>({
        folders: structuredClone(folders),
        queries: queries.map(listRow),
      }),

    getSavedQuery: (id) => {
      const query = find(id);
      return ok(query ? whole(query) : null);
    },

    searchSavedQueries: (text, connectionId) => ok(search(text, connectionId)),

    listSnippets: () =>
      ok<SnippetDefinition[]>(
        queries
          .filter((q) => q.snippetTrigger !== null)
          .map((q) => ({
            id: q.id,
            name: q.name,
            trigger: q.snippetTrigger ?? '',
            template: q.sql,
            description: q.description,
            connectionId: q.connectionId,
            database: q.database,
          }))
          .sort((a, b) => a.trigger.localeCompare(b.trigger) || a.name.localeCompare(b.name)),
      ),

    createSavedQuery: (fields) => {
      const created = insert(fields);
      if (isError(created)) return fail(created);
      announce();
      return ok(whole(created));
    },

    updateSavedQuery: (id, update: SavedQueryUpdate) => {
      const current = find(id);
      if (!current) return fail(mockErrors.savedQueryNotFound(id));
      if (update.sql !== null) {
        const big = tooLarge(update.sql);
        if (big) return fail(big);
      }
      const checked = checkedFields(update, update.connectionId !== current.connectionId);
      if (isError(checked)) return fail(checked);
      Object.assign(current, {
        name: checked.name,
        sql: update.sql ?? current.sql,
        description: checked.description,
        tags: checked.tags,
        folderId: update.folderId,
        connectionId: update.connectionId,
        database: update.connectionId ? (update.database?.trim() ?? '') || null : null,
        snippetTrigger: checked.trigger,
        updatedAt: seconds(),
      } satisfies Partial<Stored>);
      announce();
      return ok(whole(current));
    },

    moveSavedQuery: (id, folderId) => {
      const current = find(id);
      if (!current) return fail(mockErrors.savedQueryNotFound(id));
      const problem = folderProblem(folderId);
      if (problem) return fail(problem);
      current.folderId = folderId;
      announce();
      return ok(whole(current));
    },

    duplicateSavedQuery: (id, copySuffix) => {
      const source = find(id);
      if (!source) return fail(mockErrors.savedQueryNotFound(id));
      let name = `${source.name} ${copySuffix}`;
      if (Array.from(name).length > MAX_NAME) {
        const keep = Math.max(0, MAX_NAME - (Array.from(copySuffix).length + 1));
        name = `${Array.from(source.name).slice(0, keep).join('')} ${copySuffix}`;
      }
      const copy = insert({
        name,
        sql: source.sql,
        description: source.description,
        tags: source.tags,
        folderId: source.folderId,
        connectionId: source.connectionId,
        database: source.database,
        snippetTrigger: null,
      });
      if (isError(copy)) return fail(copy);
      announce();
      return ok(whole(copy));
    },

    deleteSavedQuery: (id) => {
      if (!find(id)) return fail(mockErrors.savedQueryNotFound(id));
      queries = queries.filter((q) => q.id !== id);
      announce();
      return ok(null);
    },

    touchSavedQuery: (id) => {
      const current = find(id);
      if (!current) return fail(mockErrors.savedQueryNotFound(id));
      current.lastUsedAt = seconds();
      return ok(null);
    },

    createQueryFolder: (name, parentId) => {
      const checked = checkedName(name, MAX_FOLDER_NAME, 'A folder', 'le dossier');
      if (isError(checked)) return fail(checked);
      const problem = folderProblem(parentId);
      if (problem) return fail(problem);
      if (depthOf(parentId) + 1 > MAX_DEPTH) {
        return fail(
          invalid(
            `Folders nest at most ${String(MAX_DEPTH)} levels deep.`,
            `Les dossiers s'imbriquent sur ${String(MAX_DEPTH)} niveaux au plus.`,
          ),
        );
      }
      counter += 1;
      const folder: QueryFolder = {
        id: `sqf-${String(counter)}`,
        name: checked,
        parentId,
        createdAt: seconds(),
      };
      folders.push(folder);
      announce();
      return ok({ ...folder });
    },

    renameQueryFolder: (id, name) => {
      const folder = folders.find((f) => f.id === id);
      if (!folder) return fail(mockErrors.queryFolderNotFound(id));
      const checked = checkedName(name, MAX_FOLDER_NAME, 'A folder', 'le dossier');
      if (isError(checked)) return fail(checked);
      folder.name = checked;
      announce();
      return ok({ ...folder });
    },

    moveQueryFolder: (id, parentId) => {
      const folder = folders.find((f) => f.id === id);
      if (!folder) return fail(mockErrors.queryFolderNotFound(id));
      const problem = folderProblem(parentId);
      if (problem) return fail(problem);
      if (parentId !== null && descendants(id).includes(parentId)) {
        return fail(
          invalid(
            'A folder cannot be moved into itself or into one of its subfolders.',
            "Un dossier ne peut pas être déplacé dans lui-même ni dans l'un de ses sous-dossiers.",
          ),
        );
      }
      if (depthOf(parentId) + heightOf(id) > MAX_DEPTH) {
        return fail(
          invalid(
            `Folders nest at most ${String(MAX_DEPTH)} levels deep.`,
            `Les dossiers s'imbriquent sur ${String(MAX_DEPTH)} niveaux au plus.`,
          ),
        );
      }
      folder.parentId = parentId;
      announce();
      return ok({ ...folder });
    },

    deleteQueryFolder: (id) => {
      if (!folders.some((f) => f.id === id)) return fail(mockErrors.queryFolderNotFound(id));
      const doomed = new Set(descendants(id));
      const before = queries.length;
      queries = queries.filter((q) => q.folderId === null || !doomed.has(q.folderId));
      folders = folders.filter((f) => !doomed.has(f.id));
      announce();
      return ok<FolderDeletion>({ folders: doomed.size, queries: before - queries.length });
    },

    exportSavedQueries: (path) => {
      if (!/\.json$/i.test(path) || !/^(\/|[A-Za-z]:[\\/])/.test(path)) {
        return fail(
          invalid(
            'A library file is an absolute path ending in .json.',
            'Un fichier de bibliothèque est un chemin absolu qui se termine par .json.',
          ),
        );
      }
      const file = {
        format: FORMAT,
        version: 1,
        folders: folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId })),
        queries: queries.map((q) => ({
          name: q.name,
          sql: q.sql,
          description: q.description,
          tags: q.tags,
          folderId: q.folderId,
          snippetTrigger: q.snippetTrigger,
        })),
      };
      deps.files.set(path, JSON.stringify(file, null, 2));
      return ok(null);
    },

    importSavedQueries: (path) => {
      if (!/\.json$/i.test(path) || !/^(\/|[A-Za-z]:[\\/])/.test(path)) {
        return fail(
          invalid(
            'A library file is an absolute path ending in .json.',
            'Un fichier de bibliothèque est un chemin absolu qui se termine par .json.',
          ),
        );
      }
      const text = deps.files.get(path);
      if (text === undefined) return fail(mockErrors.fileNotFound(path));
      const imported = importFile(text);
      if (isError(imported)) return fail(imported);
      announce();
      return ok(imported);
    },
  };

  interface FileFolder {
    id: string;
    name: string;
    parentId: string | null;
  }
  interface FileQuery {
    name: string;
    sql: string;
    description?: string;
    tags?: string[];
    folderId: string | null;
    snippetTrigger: string | null;
  }

  const notLibrary = (detail: string): YadbeError =>
    invalid(
      `This file is not a yadbe library: ${detail}.`,
      `Ce fichier n'est pas une bibliothèque yadbe : ${detail}.`,
    );

  /** All or nothing, like the backend's transaction: the state is restored on a failure. */
  function importFile(text: string): ImportReport | YadbeError {
    let file: { format?: unknown; version?: unknown; folders?: unknown; queries?: unknown };
    try {
      file = JSON.parse(text) as typeof file;
    } catch {
      return notLibrary('invalid JSON');
    }
    if (file.format !== FORMAT || !Array.isArray(file.folders) || !Array.isArray(file.queries)) {
      return notLibrary('unknown format');
    }
    if (file.version !== 1) {
      return invalid(
        `This library file has version ${String(file.version)}, which this yadbe cannot read.`,
        `Cette bibliothèque est en version ${String(file.version)}, que cette version de yadbe ne sait pas lire.`,
      );
    }
    const backup = {
      folders: structuredClone(folders),
      queries: structuredClone(queries),
      counter,
    };
    const report: ImportReport = { folders: 0, queries: 0, skipped: 0 };
    const mapped = new Map<string, string | null>();
    const fileFolders = file.folders as FileFolder[];
    const known = new Set(fileFolders.map((f) => f.id));

    const folderFor = (name: string, parentId: string | null): string | YadbeError => {
      const existing = folders.find((f) => f.parentId === parentId && f.name === name.trim());
      if (existing) return existing.id;
      const created = commandsSync.createFolder(name, parentId);
      if (isError(created)) return created;
      report.folders += 1;
      return created.id;
    };

    let pending = fileFolders;
    const rollback = (error: YadbeError): YadbeError => {
      folders = backup.folders;
      queries = backup.queries;
      counter = backup.counter;
      return error;
    };
    while (pending.length > 0) {
      const later: FileFolder[] = [];
      for (const folder of pending) {
        const parent = folder.parentId;
        if (parent !== null && known.has(parent) && !mapped.has(parent)) {
          later.push(folder);
          continue;
        }
        const target = parent === null ? null : (mapped.get(parent) ?? null);
        const id = folderFor(folder.name, target);
        if (isError(id)) return rollback(id);
        mapped.set(folder.id, id);
      }
      if (later.length === pending.length) {
        // A cycle: the rest goes to the root.
        for (const folder of later) {
          const id = folderFor(folder.name, null);
          if (isError(id)) return rollback(id);
          mapped.set(folder.id, id);
        }
        break;
      }
      pending = later;
    }

    for (const entry of file.queries as FileQuery[]) {
      const folderId = entry.folderId === null ? null : (mapped.get(entry.folderId) ?? null);
      const present = queries.some(
        (q) => q.folderId === folderId && q.name === entry.name.trim() && q.sql === entry.sql,
      );
      if (present) {
        report.skipped += 1;
        continue;
      }
      const created = insert({
        name: entry.name,
        sql: entry.sql,
        description: entry.description ?? '',
        tags: entry.tags ?? [],
        folderId,
        connectionId: null,
        database: null,
        snippetTrigger: entry.snippetTrigger,
      });
      if (isError(created)) return rollback(created);
      report.queries += 1;
    }
    return report;
  }

  /** Folder creation without the event, for the import. */
  const commandsSync = {
    createFolder(name: string, parentId: string | null): QueryFolder | YadbeError {
      const checked = checkedName(name, MAX_FOLDER_NAME, 'A folder', 'le dossier');
      if (isError(checked)) return checked;
      if (depthOf(parentId) + 1 > MAX_DEPTH) {
        return invalid(
          `Folders nest at most ${String(MAX_DEPTH)} levels deep.`,
          `Les dossiers s'imbriquent sur ${String(MAX_DEPTH)} niveaux au plus.`,
        );
      }
      counter += 1;
      const folder: QueryFolder = {
        id: `sqf-${String(counter)}`,
        name: checked,
        parentId,
        createdAt: seconds(),
      };
      folders.push(folder);
      return folder;
    },
  };

  seed();

  return {
    commands,
    /** A connection was deleted: its queries become global ones, like the foreign key does. */
    connectionDeleted(connectionId: string): void {
      for (const query of queries) {
        if (query.connectionId === connectionId) {
          query.connectionId = null;
          query.database = null;
        }
      }
    },
    reset(): void {
      seed();
    },
    /** Empties the library (a screen that shows its empty state). */
    clear(): void {
      folders = [];
      queries = [];
      announce();
    },
  };
}
