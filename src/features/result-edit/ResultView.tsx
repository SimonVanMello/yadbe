import { useEffect } from 'react';

import type { ResultSummary } from '../../ipc';
import { useConnection } from '../connections/connectionStore';
import { ResultGrid } from '../grid/ResultGrid';
import { tableSource } from '../table-data/tableActions';
import { useTableSession } from '../table-data/tableSessionStore';
import { EditableResultGrid } from './EditableResultGrid';
import { ResultEditStatus } from './ResultEditStatus';
import { describeResult, useResultEdit } from './resultEdits';
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
 * key (F-087), read-only otherwise, with the reason in its footer.
 */
export function ResultView({ tabId, connectionId, resultId, summary, label }: ResultViewProps) {
  const entry = useResultEdit(resultId);
  const session = useTableSession(sessionIdOf(resultId));
  const connection = useConnection(connectionId);

  useEffect(() => {
    if (connectionId === null) return;
    void describeResult(tabId, connectionId, resultId, summary.columns, summary.rowCount);
    // Described once per result: later summaries only add rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, connectionId, resultId]);

  const source = tableSource(sessionIdOf(resultId));
  if (session.phase === 'ready' && session.info && source && connection) {
    return (
      <EditableResultGrid
        key={`edit-${String(resultId)}`}
        resultId={resultId}
        summary={summary}
        label={label}
        info={session.info}
        source={source}
        connection={connection}
      />
    );
  }
  return (
    <ResultGrid
      resultId={resultId}
      summary={summary}
      label={label}
      note={<ResultEditStatus entry={entry} />}
    />
  );
}
