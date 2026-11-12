import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { showError } from '../../app/errors/presentError';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, type ResumeMode } from '../../ipc';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';
import { useExportStore } from '../export/exportStore';
import { DataGrid, type DataGridApi } from './DataGrid';
import { onGridAction } from './gridActions';
import type { HeaderSort } from './GridHeader';
import { ResultFilterBar } from './ResultFilterBar';
import { activeFilterCount } from './resultViewModel';
import { useResultViewStore } from './resultViewStore';
import { useResultView } from './useResultView';
import { IconButton } from '../../ui/IconButton';
import { useShortcutOf } from '../../app/useShortcutOf';
import { formatCount } from './formatCount';
import type { ResultGridProps } from './ResultGrid';
import type { ExportGridRange } from '../export/exportOptions';
import { createResultRowSource } from './resultRowSource';
import { useResultSelectionStore, type SelectionSize } from './resultSelectionStore';
import { useSelectionAggregate } from './useSelectionAggregate';
import styles from './ResultGrid.module.css';

/** `ResultGrid` for one result id (remounted when the id changes). */
export function ResultGridView({ resultId, summary, label }: ResultGridProps) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const [source] = useState(() =>
    createResultRowSource(resultId, summary.columns, summary.rowCount),
  );
  const [resuming, setResuming] = useState(false);
  const shortcutOf = useShortcutOf();
  const gridApi = useRef<DataGridApi | null>(null);
  const { view, info } = useResultView(
    resultId,
    source,
    summary.rowCount,
    summary.columns.length,
    useCallback(() => {
      gridApi.current?.clearSelection();
    }, []),
  );

  // `result.filter`: the filter bar opens with a first condition ready to type in, or closes.
  const viewRef = useRef(view);
  useLayoutEffect(() => {
    viewRef.current = view;
  });
  useEffect(
    () =>
      onGridAction((action) => {
        if (action !== 'result.filter') return;
        const store = useResultViewStore.getState();
        if (viewRef.current.barOpen) {
          store.setBar(resultId, false);
          return;
        }
        store.setBar(resultId, true);
        if (viewRef.current.conditions.length === 0) store.addCondition(resultId, null);
      }),
    [resultId],
  );

  const headerSort: HeaderSort = {
    keys: view.sort,
    onSort: (dataCol, additive) => {
      useResultViewStore.getState().sortBy(resultId, dataCol, additive);
    },
  };
  const filters = activeFilterCount(view);
  const toggleBar = () => {
    const store = useResultViewStore.getState();
    store.setBar(resultId, !view.barOpen);
    if (!view.barOpen && view.conditions.length === 0) store.addCondition(resultId, null);
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

  const { status, pausedBy } = summary;
  const openExport = () => {
    useExportStore.getState().open({
      label: label ?? t('grid.label', { number: summary.statementIndex + 1 }),
      source: {
        kind: 'result',
        resultId,
        rowCount: summary.rowCount,
        status,
        pausedBy,
        truncated: summary.truncated,
      },
    });
  };

  const resume = (mode: ResumeMode) => {
    setResuming(true);
    unwrap(ipc.commands.resumeResult(resultId, mode))
      .catch((error: unknown) => {
        showError(error, { title: t('grid.loadFailed') });
      })
      .finally(() => {
        setResuming(false);
      });
  };

  const footer = (
    <>
      <span className={styles.count}>
        {info
          ? formatCount(locale, 'grid.rows.shown', info.rowCount, {
              total: new Intl.NumberFormat(locale).format(info.sourceRows),
            })
          : formatCount(locale, 'grid.rows', summary.rowCount)}
      </span>
      {status === 'streaming' && (
        <span className={styles.status} role="status">
          <Spinner />
          {t('grid.status.streaming')}
        </span>
      )}
      {status === 'paused' && (
        <>
          <span className={styles.paused} role="status">
            {t(
              pausedBy === 'memoryLimit'
                ? 'grid.status.paused.memoryLimit'
                : 'grid.status.paused.rowLimit',
            )}
          </span>
          <Button
            size="sm"
            disabled={resuming}
            onClick={() => {
              resume('more');
            }}
          >
            {t('grid.loadMore')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={resuming}
            onClick={() => {
              resume('all');
            }}
          >
            {t('grid.loadAll')}
          </Button>
        </>
      )}
      <IconButton
        icon="filter"
        size="sm"
        label={t('resultView.toggle')}
        shortcut={shortcutOf('result.filter')}
        aria-pressed={view.barOpen}
        data-active={filters > 0 || undefined}
        onClick={toggleBar}
      />
      <Button size="sm" variant="ghost" onClick={openExport}>
        {t('export.menu')}
      </Button>
      {summary.truncated && status !== 'paused' && (
        <span className={styles.paused} role="status">
          {t('grid.status.exportedRest')}
        </span>
      )}
      {(status === 'cancelled' || status === 'failed') && (
        <span className={styles.stopped} role="status">
          {t(status === 'cancelled' ? 'grid.status.cancelled' : 'grid.status.failed')}
        </span>
      )}
    </>
  );

  return (
    <DataGrid
      source={source}
      sourceKey={`result-${String(resultId)}`}
      label={label ?? t('grid.label', { number: summary.statementIndex + 1 })}
      footer={footer}
      emptyText={status === 'streaming' ? undefined : t('grid.noRows')}
      onSelectionSize={onSelectionSize}
      onSelectionRange={onSelectionRange}
      onSelectionBlocks={onSelectionBlocks}
      sort={headerSort}
      apiRef={gridApi}
      top={
        view.barOpen ? (
          <ResultFilterBar resultId={resultId} columns={source.columns} view={view} />
        ) : undefined
      }
      onExport={openExport}
    />
  );
}
