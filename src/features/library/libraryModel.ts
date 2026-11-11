import type { QueryFolder, SavedQuery } from '../../ipc';
import type { BuiltinSnippet } from './builtinSnippets';
import { normalizeQuery, scoreMatch, searchable } from '../palette/matcher';

/** The library as the backend sends it. */
export interface Library {
  folders: readonly QueryFolder[];
  queries: readonly SavedQuery[];
}

export const EMPTY_LIBRARY: Library = { folders: [], queries: [] };

export interface FolderTreeRow {
  type: 'folder';
  key: string;
  folder: QueryFolder;
  /** 1 at the top of the library (ARIA `aria-level`). */
  level: number;
  expanded: boolean;
  /** Queries under it that the filters let through, subfolders included. */
  count: number;
}

export interface QueryTreeRow {
  type: 'query';
  key: string;
  query: SavedQuery;
  level: number;
  /** Characters of the name the fuzzy filter matched. */
  indices: readonly number[];
}

/** The heading of the built-in snippets, after the user's own folders and queries. */
export interface BuiltinHeaderRow {
  type: 'builtinHeader';
  key: string;
  level: 1;
  expanded: boolean;
  count: number;
}

export interface BuiltinTreeRow {
  type: 'builtin';
  key: string;
  level: 2;
  snippet: BuiltinSnippet;
  /** The snippet's name in the UI language. */
  name: string;
  indices: readonly number[];
}

export type LibraryRow = FolderTreeRow | QueryTreeRow | BuiltinHeaderRow | BuiltinTreeRow;

export const BUILTIN_HEADER_KEY = 'b:';

export function builtinKey(trigger: string): string {
  return `b:${trigger}`;
}

/**
 * The rows of the built-in snippets: their heading, then one row each while it is unfolded. A
 * text filter keeps the ones whose trigger or name match, and opens the heading.
 */
export function buildBuiltinRows(
  snippets: readonly BuiltinSnippet[],
  nameOf: (snippet: BuiltinSnippet) => string,
  text: string,
  open: boolean,
): LibraryRow[] {
  const shown: BuiltinTreeRow[] = [];
  for (const snippet of snippets) {
    const name = nameOf(snippet);
    const byName = nameMatch(name, text);
    const byTrigger = nameMatch(snippet.trigger, text);
    if (byName === null && byTrigger === null) continue;
    shown.push({
      type: 'builtin',
      key: builtinKey(snippet.trigger),
      level: 2,
      snippet,
      name,
      indices: byName ?? [],
    });
  }
  if (shown.length === 0) return [];
  const expanded = text.trim() !== '' || open;
  return [
    { type: 'builtinHeader', key: BUILTIN_HEADER_KEY, level: 1, expanded, count: shown.length },
    ...(expanded ? shown : []),
  ];
}

export interface LibraryFilter {
  /** What the filter field holds. */
  text: string;
  /** Ids the full-text search found for `text`; `null` while it has not answered. */
  textIds: ReadonlySet<string> | null;
  /** Only the global queries and this connection's; `null`: every query. */
  connectionId: string | null;
}

export const NO_FILTER: LibraryFilter = { text: '', textIds: null, connectionId: null };

export function folderKey(id: string): string {
  return `f:${id}`;
}

export function queryKey(id: string): string {
  return `q:${id}`;
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

export function isFiltering(filter: LibraryFilter): boolean {
  return filter.text.trim() !== '' || filter.connectionId !== null;
}

/** Whether a query belongs to the scope the filter asks for. */
export function inScope(query: SavedQuery, connectionId: string | null): boolean {
  return (
    connectionId === null || query.connectionId === null || query.connectionId === connectionId
  );
}

/** How the filter text matches the name of a query: `null` when it does not. */
export function nameMatch(name: string, text: string): number[] | null {
  const needle = normalizeQuery(text);
  if (needle === '') return [];
  const indices: number[] = [];
  return scoreMatch(needle, searchable(name), indices) === null ? null : indices;
}

/**
 * The tree as a flat list of rows: folders before queries, each sorted by name. Without a text
 * filter the folders the user folded stay folded; with one, every folder that holds a match is
 * open and the others are hidden. A scope filter hides the folders it empties.
 */
export function buildLibraryRows(
  library: Library,
  collapsed: ReadonlySet<string>,
  filter: LibraryFilter,
): { rows: LibraryRow[]; matches: number } {
  const text = filter.text.trim();
  const filtering = isFiltering(filter);
  const folderIds = new Set(library.folders.map((folder) => folder.id));
  const childFolders = new Map<string | null, QueryFolder[]>();
  for (const folder of [...library.folders].sort(byName)) {
    // A folder whose parent is unknown is shown at the top rather than lost.
    const parent =
      folder.parentId !== null && folderIds.has(folder.parentId) ? folder.parentId : null;
    childFolders.set(parent, [...(childFolders.get(parent) ?? []), folder]);
  }
  const childQueries = new Map<string | null, { query: SavedQuery; indices: number[] }[]>();
  let matches = 0;
  for (const query of [...library.queries].sort(byName)) {
    if (!inScope(query, filter.connectionId)) continue;
    let indices: number[] = [];
    if (text !== '') {
      const fuzzy = nameMatch(query.name, text);
      if (fuzzy === null && filter.textIds?.has(query.id) !== true) continue;
      indices = fuzzy ?? [];
    }
    matches += 1;
    const parent = query.folderId !== null && folderIds.has(query.folderId) ? query.folderId : null;
    childQueries.set(parent, [...(childQueries.get(parent) ?? []), { query, indices }]);
  }

  const countOf = new Map<string, number>();
  const count = (folderId: string): number => {
    const known = countOf.get(folderId);
    if (known !== undefined) return known;
    let total = childQueries.get(folderId)?.length ?? 0;
    for (const child of childFolders.get(folderId) ?? []) total += count(child.id);
    countOf.set(folderId, total);
    return total;
  };

  const rows: LibraryRow[] = [];
  const visit = (parent: string | null, level: number): void => {
    for (const folder of childFolders.get(parent) ?? []) {
      const total = count(folder.id);
      if (filtering && total === 0) continue;
      const expanded = text !== '' || !collapsed.has(folder.id);
      rows.push({
        type: 'folder',
        key: folderKey(folder.id),
        folder,
        level,
        expanded,
        count: total,
      });
      if (expanded) visit(folder.id, level + 1);
    }
    for (const { query, indices } of childQueries.get(parent) ?? []) {
      rows.push({ type: 'query', key: queryKey(query.id), query, level, indices });
    }
  };
  visit(null, 1);
  return { rows, matches };
}

/** Ids of `folderId` and every folder under it. */
export function folderSubtree(folders: readonly QueryFolder[], folderId: string): Set<string> {
  const ids = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId !== null && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** Number of queries in a folder and everything below it, whatever the filters. */
export function folderContents(
  library: Library,
  folderId: string,
): { folders: number; queries: number } {
  const ids = folderSubtree(library.folders, folderId);
  return {
    folders: ids.size,
    queries: library.queries.filter((query) => query.folderId !== null && ids.has(query.folderId))
      .length,
  };
}

/** A folder may go into any folder that is not itself or below it, or to the top (`null`). */
export function canMoveFolder(
  folders: readonly QueryFolder[],
  folderId: string,
  targetId: string | null,
): boolean {
  if (targetId === null) return true;
  return !folderSubtree(folders, folderId).has(targetId);
}

export interface FolderOption {
  id: string;
  /** `Reports / Monthly`. */
  label: string;
  depth: number;
}

/** Every folder with its path, in tree order: what a folder picker lists. */
export function folderOptions(
  folders: readonly QueryFolder[],
  exclude: ReadonlySet<string> = new Set(),
): FolderOption[] {
  const options: FolderOption[] = [];
  const byParent = new Map<string | null, QueryFolder[]>();
  const known = new Set(folders.map((folder) => folder.id));
  for (const folder of [...folders].sort(byName)) {
    const parent = folder.parentId !== null && known.has(folder.parentId) ? folder.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), folder]);
  }
  const visit = (parent: string | null, path: string[]): void => {
    for (const folder of byParent.get(parent) ?? []) {
      if (exclude.has(folder.id)) continue;
      const next = [...path, folder.name];
      options.push({ id: folder.id, label: next.join(' / '), depth: path.length });
      visit(folder.id, next);
    }
  };
  visit(null, []);
  return options;
}

export function folderPath(folders: readonly QueryFolder[], folderId: string | null): string {
  const names: string[] = [];
  let cursor = folderId;
  for (let guard = 0; cursor !== null && guard < 32; guard++) {
    const folder = folders.find((candidate) => candidate.id === cursor);
    if (!folder) break;
    names.unshift(folder.name);
    cursor = folder.parentId;
  }
  return names.join(' / ');
}

const NAME_CHARS = 80;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The first line of text of the comment a statement starts with, `null` when it has none. */
function leadingComment(text: string): string | null {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('--')) {
    for (const line of trimmed.split(/\r?\n/)) {
      const current = line.trim();
      if (!current.startsWith('--')) return null;
      const body = current.replace(/^-+\s*/, '');
      if (body !== '') return body;
    }
    return null;
  }
  if (trimmed.startsWith('/*')) {
    const end = trimmed.indexOf('*/');
    const inner = trimmed.slice(2, end === -1 ? undefined : end);
    for (const line of inner.split(/\r?\n/)) {
      const body = line.replace(/^\s*\*+\s?/, '').trim();
      if (body !== '') return body;
    }
  }
  return null;
}

/**
 * A name for a statement being saved: its leading comment when it has one (that is what people
 * write to say what a query is for), else its first line.
 */
export function suggestName(sql: string, fallback: string): string {
  const text = sql.trim();
  if (text === '') return fallback;
  const comment = leadingComment(text);
  if (comment !== null) return clip(comment, NAME_CHARS);
  const first = text
    .split(/\r?\n/)
    .find((line) => line.trim() !== '' && !line.trim().startsWith('--'));
  const statement = (first ?? '').trim().replace(/;+$/, '').trim();
  return statement === '' ? fallback : clip(statement, NAME_CHARS);
}

/** Tags as the dialog's field writes them: comma separated. */
export function parseTags(text: string): string[] {
  return text
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

export function formatTags(tags: readonly string[]): string {
  return tags.join(', ');
}
