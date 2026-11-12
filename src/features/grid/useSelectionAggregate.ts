import { useCallback, useEffect, useState } from 'react';

import { ipc, unwrap } from '../../ipc';
import type { SelectionBlock } from './DataGrid';
import { useResultSelectionStore } from './resultSelectionStore';

/** The selection settles before the backend is asked: dragging does not send a request per row. */
const SETTLE_MS = 150;

/**
 * Computes what the selection of a result grid adds up to (F-065) in the backend, where the rows
 * are, and reports it for the status bar. Returns the callback the grid reports its selection to.
 * An answer for a selection that has changed since is dropped.
 */
export function useSelectionAggregate(resultId: number): (blocks: SelectionBlock[] | null) => void {
  const [blocks, setBlocks] = useState<SelectionBlock[] | null>(null);
  const onSelectionBlocks = useCallback((next: SelectionBlock[] | null) => {
    setBlocks(next);
  }, []);

  useEffect(() => {
    const report = useResultSelectionStore.getState().reportAggregate;
    // One cell has nothing to add up: the figures start with two.
    const cells = blocks?.reduce(
      (sum, block) => sum + Math.max(0, block.rowEnd - block.rowStart) * block.columns.length,
      0,
    );
    if (!blocks || cells === undefined || cells < 2) {
      report(resultId, null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      unwrap(ipc.commands.aggregateResultSelection(resultId, blocks)).then(
        (aggregate) => {
          if (current) report(resultId, aggregate);
        },
        () => {
          if (current) report(resultId, null);
        },
      );
    }, SETTLE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [resultId, blocks]);

  return onSelectionBlocks;
}
