import { useCallback } from 'react';

import { ipc, unwrap, type DocumentResult } from '../../ipc';
import { DocumentsView } from '../documents/DocumentsView';
import { ResultGrid } from '../grid/ResultGrid';
import type { HitsView } from './indexStore';
import { jsonDocument } from './jsonView';

interface HitsResultsProps {
  result: DocumentResult;
  view: HitsView;
  label: string;
}

/**
 * Search hits shown two ways over the same rows kept in the backend: the grid of their fields
 * (`_index`, `_id`, `_score`, then `_source` flattened; a field a hit lacks reads "missing"),
 * or the whole hits as trees.
 */
export function HitsResults({ result, view, label }: HitsResultsProps) {
  const { documentsId } = result;
  const load = useCallback(
    async (offset: number, limit: number) =>
      (await unwrap(ipc.commands.searchFetchDocuments(documentsId, offset, limit))).map(
        jsonDocument,
      ),
    [documentsId],
  );
  if (view === 'documents') {
    return <DocumentsView key={documentsId} count={result.count} load={load} label={label} />;
  }
  return <ResultGrid resultId={result.result.resultId} summary={result.result} label={label} />;
}
