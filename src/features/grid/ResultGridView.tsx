import { useCallback, useEffect, useRef, useState } from 'react';

import { useT } from '../../i18n/useT';
import { useExportStore } from '../export/exportStore';
import { DataGrid, type DataGridApi } from './DataGrid';
import type { HeaderSort } from './GridHeader';
import type { ResultGridProps } from './ResultGrid';
import type { ExportGridRange } from '../export/exportOptions';
import { openResultExport, ResultFooter } from './ResultFooter';
import { createResultRowSource } from './resultRowSource';
import { blockText } from './rowSource';
import { useResultSelectionStore, type SelectionSize } from './resultSelectionStore';
import { useResultViewStore } from './resultViewStore';
import { useResultView } from './useResultView';
import { useSelectionAggregate } from './useSelectionAggregate';

/** `ResultGrid` for one result id (remounted when the id changes). */
export function ResultGridView({ resultId, summary, label, note, rowMenu }: ResultGridProps) {
  const t = useT();
  const [source] = useState(() =>
    createResultRowSource(resultId, summary.columns, summary.rowCount),
  );
  const gridApi = useRef<DataGridApi | null>(null);
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const { view, info } = useResultView(
    resultId,
    source,
    summary.rowCount,
    summary.columns.length,
    useCallback(() => {
      gridApi.current?.clearSelection();
    }, []),
  );

  const headerSort: HeaderSort = {
    keys: view.sort,
    onSort: (dataCol, additive) => {
      useResultViewStore.getState().sortBy(resultId, dataCol, additive);
    },
  };

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

  const onSelectionBlocks = useSelectionAggregate(resultId);

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
          <ResultFooter
            resultId={resultId}
            summary={summary}
            label={name}
            viewInfo={info}
            view={view}
          />
          {note}
        </>
      }
      emptyText={summary.status === 'streaming' ? undefined : t('grid.noRows')}
      onSelectionSize={onSelectionSize}
      onSelectionRange={onSelectionRange}
      onSelectionBlocks={onSelectionBlocks}
      sort={headerSort}
      apiRef={gridApi}
      onExport={openExport}
      onFocusChange={
        rowMenu
          ? (cell) => {
              setFocusRow(cell?.row ?? null);
            }
          : undefined
      }
      menuExtras={
        rowMenu && focusRow !== null
          ? rowMenu((column) => {
              const block = source.block(focusRow);
              const col = summary.columns.findIndex((c) => c.name === column);
              return block && col !== -1 ? blockText(block, focusRow - block.offset, col) : null;
            })
          : undefined
      }
    />
  );
}
