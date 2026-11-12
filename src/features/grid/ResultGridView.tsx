import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

import { useT } from '../../i18n/useT';
import { useExportStore } from '../export/exportStore';
import { DataGrid } from './DataGrid';
import type { ResultGridProps } from './ResultGrid';
import type { ExportGridRange } from '../export/exportOptions';
import { openResultExport, ResultFooter } from './ResultFooter';
import { createResultRowSource } from './resultRowSource';
import { useResultSelectionStore, type SelectionSize } from './resultSelectionStore';

/** `ResultGrid` for one result id (remounted when the id changes). */
export function ResultGridView({ resultId, summary, label, note }: ResultGridProps) {
  const t = useT();
  const [source] = useState(() =>
    createResultRowSource(resultId, summary.columns, summary.rowCount),
  );

  useLayoutEffect(() => {
    source.setRowCount(summary.rowCount);
  }, [source, summary.rowCount]);

  useEffect(() => {
    source.revive();
    return () => {
      source.dispose();
      useResultSelectionStore.getState().clear(resultId);
      useExportStore.getState().forgetRange(resultId);
    };
  }, [source, resultId]);

  const onSelectionSize = useCallback(
    (size: SelectionSize | null) => {
      useResultSelectionStore.getState().report(resultId, size);
    },
    [resultId],
  );

  const onSelectionRange = useCallback(
    (range: ExportGridRange | null) => {
      useExportStore.getState().setRange(resultId, range);
    },
    [resultId],
  );

  const name = label ?? t('grid.label', { number: summary.statementIndex + 1 });
  const openExport = () => {
    openResultExport(resultId, summary, name);
  };

  return (
    <DataGrid
      source={source}
      sourceKey={`result-${String(resultId)}`}
      label={name}
      footer={
        <>
          <ResultFooter resultId={resultId} summary={summary} label={name} />
          {note}
        </>
      }
      emptyText={summary.status === 'streaming' ? undefined : t('grid.noRows')}
      onSelectionSize={onSelectionSize}
      onSelectionRange={onSelectionRange}
      onExport={openExport}
    />
  );
}
