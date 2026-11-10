import { isTableTab, selectActiveTab, useTabsStore } from '../../app/tabs/tabsStore';
import { useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { formatCount } from '../grid/formatCount';
import styles from './TableControls.module.css';
import { useTableSelectionStore, useTableSessionStore } from './tableSessionStore';

/** The active table tab in the status bar (SPEC §4): its rows, the selection, `3 pending`. */
export function TableStatus() {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const tabId = useTabsStore((state) => {
    const tab = selectActiveTab(state);
    return isTableTab(tab) ? tab.id : null;
  });
  const rows = useTableSessionStore((state) =>
    tabId === null ? null : (state.sessions[tabId]?.page?.rowCount ?? null),
  );
  const pending = useTableSessionStore((state) =>
    tabId === null ? 0 : (state.sessions[tabId]?.pendingCount ?? 0),
  );
  const selection = useTableSelectionStore((state) =>
    tabId === null ? null : (state.sizes[tabId] ?? null),
  );
  if (tabId === null || rows === null) return null;
  const cells = selection ? selection.rows * selection.cols : 0;
  return (
    <span className={styles.status} data-testid="statusbar-table">
      <span>{formatCount(locale, 'grid.rows', rows)}</span>
      {cells > 1 && (
        <span className={styles.muted}>· {formatCount(locale, 'grid.cellsSelected', cells)}</span>
      )}
      {pending > 0 && (
        <span className={styles.statusPending}>· {t('tableData.pending', { count: pending })}</span>
      )}
    </span>
  );
}
