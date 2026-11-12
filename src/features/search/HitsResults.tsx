import { useCallback } from 'react';

import { ipc, unwrap, type DocumentResult } from '../../ipc';
import type { DocNode } from '../documents/docTree';
import { DocumentsView } from '../documents/DocumentsView';
import { ResultGrid } from '../grid/ResultGrid';
import { HitMenuItems } from './HitMenuItems';
import type { HitsView } from './indexStore';
import { jsonDocument } from './jsonView';
import { findHit, hitAt } from './searchEditActions';

interface HitsResultsProps {
  result: DocumentResult;
  view: HitsView;
  label: string;
  /** The index tab showing them: their menus edit, duplicate, delete (M4-8). */
  editTabId?: string;
}

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
  const load = useCallback(
    async (offset: number, limit: number) =>
      (await unwrap(ipc.commands.searchFetchDocuments(documentsId, offset, limit))).map(
        jsonDocument,
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
        documentMenu={
          editTabId === undefined
            ? undefined
            : (document, node) => (
                <HitMenuItems
                  tabId={editTabId}
                  index={hitField(node, '_index')}
                  load={() => hitAt(editTabId, document)}
                />
              )
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
