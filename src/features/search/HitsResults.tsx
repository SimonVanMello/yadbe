import { useCallback, useEffect, useRef } from 'react';

import { showError } from '../../app/errors/presentError';
import { ipc, unwrap, type DocumentResult } from '../../ipc';
import type { DocNode } from '../documents/docTree';
import { DocumentsView } from '../documents/DocumentsView';
import { registerExportDocuments } from '../export/exportDocuments';
import { ResultGrid } from '../grid/ResultGrid';
import { HitMenuItems } from './HitMenuItems';
import type { HitsView } from './indexStore';
import { jsonDocument } from './jsonView';
import { editHit, findHit, hitAt } from './searchEditActions';

interface HitsResultsProps {
  result: DocumentResult;
  view: HitsView;
  label: string;
  /** The index tab showing them: their menus edit, duplicate, delete (M4-8). */
  editTabId?: string;
}

const NO_DOCS: readonly DocNode[] = [];

/** A string field of a hit shown in the documents view. */
function hitField(node: DocNode | undefined, name: string): string | null {
  if (node?.type !== 'object') return null;
  const value = node.entries.find(([key]) => key === name)?.[1];
  if (value?.type !== 'scalar') return null;
  try {
    const parsed = JSON.parse(value.json) as unknown;
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Search hits shown two ways over the same rows kept in the backend: the grid of their fields
 * (`_index`, `_id`, `_score`, then `_source` flattened; a field a hit lacks reads "missing"),
 * or the whole hits as trees.
 */
export function HitsResults({ result, view, label, editTabId }: HitsResultsProps) {
  const { documentsId } = result;
  const gridId = result.result.resultId;
  // JSON Lines exports the whole hits, not the grid rows the export dialog opens on.
  useEffect(
    () => registerExportDocuments(gridId, { documentsId, kind: 'search' }),
    [gridId, documentsId],
  );
  // The hits read, by number: a row's menu names the hit's index before reading it again.
  const read = useRef(new Map<number, DocNode>());
  const load = useCallback(
    async (offset: number, limit: number) => {
      const nodes = (
        await unwrap(ipc.commands.searchFetchDocuments(documentsId, offset, limit))
      ).map(jsonDocument);
      if (offset === 0) read.current.clear();
      nodes.forEach((node, i) => read.current.set(offset + i, node));
      return nodes;
    },
    [documentsId],
  );
  if (view === 'documents') {
    return (
      <DocumentsView
        key={documentsId}
        count={result.count}
        load={load}
        label={label}
        editing={
          editTabId === undefined
            ? undefined
            : {
                // Edits of hits are staged as whole documents (the pending strip), not
                // overlaid on the tree: only the row menu and F2 / double click are used.
                document: () => undefined,
                added: NO_DOCS,
                version: '',
                menu: (row) => (
                  <HitMenuItems
                    tabId={editTabId}
                    index={hitField(read.current.get(row.document), '_index')}
                    load={() => hitAt(editTabId, row.document)}
                  />
                ),
                onEdit: (row) => {
                  hitAt(editTabId, row.document)
                    .then((hit) => (hit ? editHit(editTabId, hit) : undefined))
                    .catch(showError);
                },
              }
        }
      />
    );
  }
  return (
    <ResultGrid
      resultId={result.result.resultId}
      summary={result.result}
      label={label}
      rowMenu={
        editTabId === undefined
          ? undefined
          : (cell) => {
              const index = cell('_index');
              const id = cell('_id');
              return (
                <HitMenuItems
                  tabId={editTabId}
                  index={index}
                  load={() =>
                    index === null || id === null
                      ? Promise.resolve(null)
                      : findHit(editTabId, index, id)
                  }
                />
              );
            }
      }
    />
  );
}
