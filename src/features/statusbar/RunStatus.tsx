import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { SelectionAggregate } from '../../ipc';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { Tooltip } from '../../ui/Tooltip';
import { formatCount } from '../grid/formatCount';
import { useResultSelectionStore } from '../grid/resultSelectionStore';
import { isActive, isWorking } from '../query/executionModel';
import { useElapsedMs, useTabExecution } from '../query/executionStore';
import { formatDuration } from '../query/format';
import styles from './StatusBar.module.css';

/**
 * The active tab's last run in the status bar (SPEC §4): `✓ 1 284 rows · 38 ms`, live while it
 * runs, then the size of the selection in its result grid.
 */
export function RunStatus() {
  const tabId = useTabsStore((state) => selectActiveTab(state).id);
  const execution = useTabExecution(tabId);
  if (execution.status === 'idle') return null;
  return <RunStatusLine tabId={tabId} />;
}

function RunStatusLine({ tabId }: { tabId: string }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const execution = useTabExecution(tabId);
  const elapsed = useElapsedMs(tabId);
  const selection = useResultSelectionStore((state) =>
    state.size && execution.results.some((result) => result.resultId === state.resultId)
      ? state.size
      : null,
  );
  const aggregate = useResultSelectionStore((state) =>
    state.size && execution.results.some((result) => result.resultId === state.resultId)
      ? state.aggregate
      : null,
  );
  const { status } = execution;
  const rows = execution.results.reduce((sum, result) => sum + result.rowCount, 0);
  const time = formatDuration(elapsed);
  const cells = selection ? selection.rows * selection.cols : 0;

  let icon = null;
  let text: string;
  if (isActive(status)) {
    icon = isWorking(status) ? <Spinner /> : null;
    text = `${formatCount(locale, 'grid.rows', rows)} · ${time}`;
  } else if (status === 'failed') {
    icon = <Icon name="error" className={styles.failedIcon} />;
    text = t('query.status.failed', { time });
  } else if (status === 'cancelled') {
    text = t('query.status.cancelled', { time });
  } else {
    icon = <Icon name="check" />;
    text =
      execution.results.length === 0
        ? t('query.status.succeededNoRows', {
            statements: t('query.status.statementCount', { count: execution.statements.length }),
            time,
          })
        : `${formatCount(locale, 'grid.rows', rows)} · ${time}`;
  }

  // The time shown leaves out the pauses at a result cap; the wall time stays one hover away.
  const wall =
    execution.pausedMs > 0
      ? t('query.status.wallTime', {
          total: formatDuration(elapsed + execution.pausedMs),
          paused: formatDuration(execution.pausedMs),
        })
      : null;
  const line = (
    <span className={styles.run} data-testid="statusbar-run" tabIndex={wall ? 0 : undefined}>
      {icon}
      <span>{text}</span>
      {cells > 1 && (
        <span className={styles.muted}>· {formatCount(locale, 'grid.cellsSelected', cells)}</span>
      )}
      {cells > 1 && aggregate && <AggregateFigures aggregate={aggregate} />}
    </span>
  );
  return wall ? <Tooltip content={wall}>{line}</Tooltip> : line;
}

const MAX_FIGURE_CHARS = 28;

/** The count, and for numbers the sum, average, minimum and maximum of the selection (F-065). */
function AggregateFigures({ aggregate }: { aggregate: SelectionAggregate }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const figures = [
    ['sum', aggregate.sum],
    ['avg', aggregate.avg],
    ['min', aggregate.min],
    ['max', aggregate.max],
  ] as const;
  return (
    <span className={styles.figures} data-testid="selection-aggregate">
      <span title={t('grid.aggregate.count.hint')}>
        {t('grid.aggregate.count', {
          count: new Intl.NumberFormat(locale).format(aggregate.nonNull),
        })}
      </span>
      {figures.map(([name, value]) => {
        if (value === null) return null;
        const shown =
          value.length > MAX_FIGURE_CHARS ? `${value.slice(0, MAX_FIGURE_CHARS)}…` : value;
        return (
          <span key={name} title={value}>
            {t(`grid.aggregate.${name}`, { value: `${aggregate.exact ? '' : '≈ '}${shown}` })}
          </span>
        );
      })}
    </span>
  );
}
