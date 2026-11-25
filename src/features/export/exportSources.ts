import type {
  ExportScope,
  ExportSourceSpec,
  IndexQueryMode,
  IndexSort,
  PauseReason,
  ResultStatus,
  SortKey,
  TableFilter,
} from '../../ipc';

/** A query result on screen. */
export interface ResultExportSource {
  kind: 'result';
  resultId: number;
  rowCount: number;
  status: ResultStatus;
  pausedBy: PauseReason | null;
  /** An earlier export read the rows past the limit: only the stored rows can be exported. */
  truncated: boolean;
}

/** Every row of a table tab's table under the tab's filter and sort, read from the server. */
export interface TableExportSource {
  kind: 'table';
  tabId: string;
  filter: TableFilter;
  sort: SortKey[];
  /** The tab has changes not applied yet: the file holds the stored rows, not them. */
  pending: boolean;
}

/** How many documents a whole collection or index holds under its query, as its tab knows. */
export interface KnownCount {
  value: number;
  /** Counted (`exact`), from the collection's metadata (`estimated`), or a lower bound. */
  kind: 'exact' | 'estimated' | 'atLeast';
}

/** The page a collection or index tab shows: a selection of its grid exports on its own. */
export interface FamilyPage {
  /** The grid result. */
  resultId: number;
  /** The whole documents of the same page. */
  documentsId: number;
}

interface FamilyExportBase {
  connectionId: string;
  count: KnownCount | null;
  page: FamilyPage | null;
  /** Some documents are filtered out by the tab's query. */
  filtered: boolean;
  /** The tab has edits not applied yet: the file holds the documents as stored. */
  pending: boolean;
}

/** Every document of a collection under a collection tab's filter, projection and sort. */
export interface CollectionExportSource extends FamilyExportBase {
  kind: 'collection';
  database: string;
  collection: string;
  filter: string;
  projection: string;
  sort: string;
}

/** Every hit of an index tab's query, `_source` filter and sort. */
export interface IndexExportSource extends FamilyExportBase {
  kind: 'index';
  target: string;
  mode: IndexQueryMode;
  text: string;
  source: string;
  sort: IndexSort[];
}

export type ExportSource =
  ResultExportSource | TableExportSource | CollectionExportSource | IndexExportSource;

/** What JSON Lines writes whole for a source, when it has documents. */
export type DocumentsKind = 'mongo' | 'search';

export function documentsKindOf(source: ExportSource): DocumentsKind | null {
  return source.kind === 'collection' ? 'mongo' : source.kind === 'index' ? 'search' : null;
}

/** The grid result whose selection the dialog can export on its own. */
export function selectableResultOf(source: ExportSource): number | null {
  return source.kind === 'result'
    ? source.resultId
    : source.kind === 'collection' || source.kind === 'index'
      ? (source.page?.resultId ?? null)
      : null;
}

/** Identifies a source, so that the dialog starts over on another one. */
export function sourceKey(source: ExportSource): string {
  switch (source.kind) {
    case 'result':
      return `result:${String(source.resultId)}`;
    case 'table':
      return `table:${source.tabId}`;
    case 'collection':
      return `collection:${source.connectionId}:${source.database}.${source.collection}`;
    case 'index':
      return `index:${source.connectionId}:${source.target}`;
  }
}

/**
 * What the backend reads for an export of `source`. A selection (`scope` is a range) is cut
 * from the page shown; otherwise a collection or an index is read whole under its query.
 * `wholeDocuments`: the file is JSON Lines of whole documents, so the rows are documents.
 * `documentsId`: where the documents of a result grid are (a page's, or a registered one's).
 */
export function exportSourceSpec(
  source: ExportSource,
  scope: ExportScope,
  wholeDocuments: boolean,
  documentsId: number | null,
): ExportSourceSpec {
  switch (source.kind) {
    case 'result':
      return {
        kind: 'result',
        resultId: (wholeDocuments ? documentsId : null) ?? source.resultId,
        scope,
      };
    case 'table':
      return { kind: 'table', tabId: source.tabId, filter: source.filter, sort: source.sort };
    case 'collection':
    case 'index': {
      if (scope.kind === 'range' && source.page) {
        return {
          kind: 'result',
          resultId: wholeDocuments ? source.page.documentsId : source.page.resultId,
          scope,
        };
      }
      return source.kind === 'collection'
        ? {
            kind: 'collection',
            connectionId: source.connectionId,
            database: source.database,
            collection: source.collection,
            filter: source.filter,
            projection: source.projection,
            sort: source.sort,
            documents: wholeDocuments,
          }
        : {
            kind: 'index',
            connectionId: source.connectionId,
            target: source.target,
            mode: source.mode,
            text: source.text,
            source: source.source,
            sort: source.sort,
            documents: wholeDocuments,
          };
    }
  }
}

/** The rows an export will write, when known exactly (a progress of "n of total"). */
export function exactTotal(source: ExportSource, scope: ExportScope): number | null {
  if (scope.kind === 'range') return null;
  if (source.kind === 'collection' || source.kind === 'index') {
    return source.count?.kind === 'exact' ? source.count.value : null;
  }
  return null;
}
