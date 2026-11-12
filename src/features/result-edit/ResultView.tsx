import { useEffect, useLayoutEffect, useMemo } from 'react';

import type { ResultSummary } from '../../ipc';
import { useConnection } from '../connections/connectionStore';
import { onGridAction } from '../grid/gridActions';
import { ResultFilterBar } from '../grid/ResultFilterBar';
import { ResultGrid } from '../grid/ResultGrid';
import type { GridColumn } from '../grid/rowSource';
import { EMPTY_VIEW, toSpec } from '../grid/resultViewModel';
import { toggleFilterBar, useResultViewStore } from '../grid/resultViewStore';
import { tableSource } from '../table-data/tableActions';
import { useTableSession } from '../table-data/tableSessionStore';
import { EditableResultGrid } from './EditableResultGrid';
import styles from './ResultEdit.module.css';
import { ResultEditStatus } from './ResultEditStatus';
import { describeResult, growResult, useResultEdit } from './resultEdits';
import { sessionIdOf } from './resultEditModel';

interface ResultViewProps {
  /** The query tab that ran it. */
  tabId: string;
  /** The connection it ran on. */
  connectionId: string | null;
  resultId: number;
  summary: ResultSummary;
  label: string;
}

/**
 * A result set of a query tab: editable like a table tab when it comes from one table with its
 * key (F-087), read-only otherwise, with the reason in its footer. A sort or a filter of its rows
 * (F-065) shows them read-only: an edit addresses the rows as they were stored, so it waits for
 * the view to be gone (pending changes stay, and come back with the rows they were made on).
 */
export function ResultView({ tabId, connectionId, resultId, summary, label }: ResultViewProps) {
  const entry = useResultEdit(resultId);
  const session = useTableSession(sessionIdOf(resultId));
  const connection = useConnection(connectionId);
  const view = useResultViewStore((state) => state.views[resultId]) ?? EMPTY_VIEW;
  const viewApplied = useResultViewStore((state) => state.applied[resultId] === true);
  const columnCount = summary.columns.length;
  const viewWanted = useMemo(
    () => toSpec(view, columnCount) !== null,
    // The bar being open or closed changes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view.sort, view.conditions, view.matchCase, columnCount],
  );

  useEffect(() => {
    if (connectionId === null) return;
    void describeResult(tabId, connectionId, resultId, summary.columns, summary.rowCount);
    // Described once per result: later summaries only add rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, connectionId, resultId]);

  // Rows that stream in join the edit session, shown or not.
  useLayoutEffect(() => {
    growResult(resultId, summary.rowCount);
  }, [resultId, summary.rowCount, session.phase]);

  // `result.filter`: the filter bar opens with a first condition ready to type in, or closes.
  useEffect(
    () =>
      onGridAction((action) => {
        if (action === 'result.filter') toggleFilterBar(resultId);
      }),
    [resultId],
  );

  const columns = useMemo<GridColumn[]>(
    () =>
      summary.columns.map((column) => ({
        name: column.name,
        typeName: column.typeName,
        kind: column.kind,
        readOnlyReason: null,
      })),
    [summary.columns],
  );

  const source = tableSource(sessionIdOf(resultId));
  const info = session.phase === 'ready' ? session.info : null;
  const editable = info !== null && source !== undefined && connection !== undefined;
  // Until the backend has dropped the view, its windows and aggregates are still sorted.
  const sorted = viewWanted || viewApplied;
  const grid =
    info && source && connection && !sorted ? (
      <EditableResultGrid
        key={`edit-${String(resultId)}`}
        resultId={resultId}
        summary={summary}
        label={label}
        info={info}
        source={source}
        connection={connection}
      />
    ) : (
      <ResultGrid
        resultId={resultId}
        summary={summary}
        label={label}
        note={
          <ResultEditStatus
            entry={entry}
            sorted={editable ? { pending: session.pendingCount } : null}
          />
        }
      />
    );

  // The bar stays mounted when the grid switches between editable and sorted: typing in it is
  // not interrupted.
  return (
    <div className={styles.frame}>
      {view.barOpen && <ResultFilterBar resultId={resultId} columns={columns} view={view} />}
      <div className={styles.body}>{grid}</div>
    </div>
  );
}
