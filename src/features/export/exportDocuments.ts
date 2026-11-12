/**
 * The whole documents behind a grid result of the document and search families. A MongoDB or
 * search result is kept twice in the backend: as a grid (the top-level fields as columns) and as
 * documents (`documentsId`). The grid is what the export dialog is opened on; JSON Lines writes
 * the documents, so the views that show such a grid say where its documents are.
 */
export interface ExportDocuments {
  documentsId: number;
  kind: 'mongo' | 'search';
}

const registered = new Map<number, ExportDocuments>();

/** Declares the documents of the grid result `resultId`; returns what takes it back. */
export function registerExportDocuments(resultId: number, documents: ExportDocuments): () => void {
  registered.set(resultId, documents);
  return () => {
    if (registered.get(resultId) === documents) registered.delete(resultId);
  };
}

export function documentsOf(resultId: number): ExportDocuments | null {
  return registered.get(resultId) ?? null;
}
