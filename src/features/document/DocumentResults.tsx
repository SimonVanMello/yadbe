import { useCallback, useEffect } from 'react';

import { ipc, unwrap, type DocumentResult } from '../../ipc';
import { registerExportDocuments } from '../export/exportDocuments';
import { DocumentsView } from '../documents/DocumentsView';
import { ResultGrid } from '../grid/ResultGrid';
import { openResultExport } from '../grid/ResultFooter';
import type { DocumentViewMode } from './collectionStore';
import { ejsonDocument } from './ejsonView';

interface DocumentResultsProps {
  result: DocumentResult;
  view: DocumentViewMode;
  label: string;
  /** The documents are the page of a collection tab: this exports the whole collection. */
  exportWhole?: () => void;
}

/**
 * The documents of a result, shown two ways over the same rows kept in the backend: the grid of
 * their top-level fields (a field a document lacks reads "missing", unlike null), or the
 * documents themselves as trees.
 */
export function DocumentResults({ result, view, label, exportWhole }: DocumentResultsProps) {
  const { documentsId } = result;
  const gridId = result.result.resultId;
  // JSON Lines exports these documents, not the grid rows the export dialog opens on.
  useEffect(
    () => registerExportDocuments(gridId, { documentsId, kind: 'mongo', openWhole: exportWhole }),
    [gridId, documentsId, exportWhole],
  );
  const load = useCallback(
    async (offset: number, limit: number) =>
      (await unwrap(ipc.commands.mongoFetchDocuments(documentsId, offset, limit))).map(
        ejsonDocument,
      ),
    [documentsId],
  );
  if (view === 'documents') {
    return (
      <DocumentsView
        key={documentsId}
        count={result.count}
        load={load}
        label={label}
        onExport={() => {
          openResultExport(gridId, result.result, label);
        }}
      />
    );
  }
  return <ResultGrid resultId={result.result.resultId} summary={result.result} label={label} />;
}
