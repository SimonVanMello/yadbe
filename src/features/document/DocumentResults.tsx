import { useCallback } from 'react';

import { ipc, unwrap, type DocumentResult } from '../../ipc';
import { DocumentsView } from '../documents/DocumentsView';
import { ResultGrid } from '../grid/ResultGrid';
import type { DocumentViewMode } from './collectionStore';
import { ejsonDocument } from './ejsonView';

interface DocumentResultsProps {
  result: DocumentResult;
  view: DocumentViewMode;
  label: string;
}

/**
 * The documents of a result, shown two ways over the same rows kept in the backend: the grid of
 * their top-level fields (a field a document lacks reads "missing", unlike null), or the
 * documents themselves as trees.
 */
export function DocumentResults({ result, view, label }: DocumentResultsProps) {
  const { documentsId } = result;
  const load = useCallback(
    async (offset: number, limit: number) =>
      (await unwrap(ipc.commands.mongoFetchDocuments(documentsId, offset, limit))).map(
        ejsonDocument,
      ),
    [documentsId],
  );
  if (view === 'documents') {
    return <DocumentsView key={documentsId} count={result.count} load={load} label={label} />;
  }
  return <ResultGrid resultId={result.result.resultId} summary={result.result} label={label} />;
}
