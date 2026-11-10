import { selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
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

  return (
    <span className={styles.run} data-testid="statusbar-run">
      {icon}
      <span>{text}</span>
      {cells > 1 && (
        <span className={styles.muted}>· {formatCount(locale, 'grid.cellsSelected', cells)}</span>
      )}
    </span>
  );
}
