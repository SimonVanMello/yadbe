import { useState } from 'react';

import { showError } from '../../app/errors/presentError';
import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { useShortcutOf } from '../../app/useShortcutOf';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, type ResultSummary, type ResultViewInfo, type ResumeMode } from '../../ipc';
import { Button } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import { Spinner } from '../../ui/Spinner';
import { useExportStore } from '../export/exportStore';
import { formatCount } from './formatCount';
import styles from './ResultGrid.module.css';
import { activeFilterCount, type ResultViewState } from './resultViewModel';
import { toggleFilterBar } from './resultViewStore';

/** Opens the export dialog of a result (F-066), from its footer, its menu or a shortcut. */
export function openResultExport(resultId: number, summary: ResultSummary, label: string): void {
  useExportStore.getState().open({
    label,
    connectionId: selectActiveTab(useTabsStore.getState()).connectionId,
    source: {
      kind: 'result',
      resultId,
      rowCount: summary.rowCount,
      status: summary.status,
      pausedBy: summary.pausedBy,
      truncated: summary.truncated,
    },
  });
}

/**
 * The footer of a result grid: its row count (the rows a sort or filter shows of it, F-065),
 * whether it streams or waits at its cap (with Load more / Load all, F-062), the filter, the
 * export, and how it ended.
 */
export function ResultFooter({
  resultId,
  summary,
  label,
  viewInfo,
  view,
}: {
  resultId: number;
  summary: ResultSummary;
  label: string;
  /** Rows shown and rows held while a view is in force, `null` without one. */
  viewInfo: ResultViewInfo | null;
  /** The sort and filter asked for. */
  view: ResultViewState;
}) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const shortcutOf = useShortcutOf();
  const [resuming, setResuming] = useState(false);
  const filters = activeFilterCount(view);
  const { status, pausedBy } = summary;

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

  return (
    <>
      <span className={styles.count}>
        {viewInfo
          ? formatCount(locale, 'grid.rows.shown', viewInfo.rowCount, {
              total: new Intl.NumberFormat(locale).format(viewInfo.sourceRows),
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
        onClick={() => {
          toggleFilterBar(resultId);
        }}
      />
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          openResultExport(resultId, summary, label);
        }}
      >
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
}
