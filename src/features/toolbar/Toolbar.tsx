import { useShortcutOf } from '../../app/useShortcutOf';
import { useLayoutStore } from '../../app/layout/layoutStore';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import { IconButton } from '../../ui/IconButton';
import type { ConnectionSummary } from '../connections/model';
import { QueryControls } from '../query/QueryControls';
import { DdlControls } from '../objects/DdlControls';
import { TableControls } from '../table-data/TableControls';
import styles from './Toolbar.module.css';

/**
 * Toolbar of a bound tab: panels, then the query controls (run, transactions, files) or the
 * table controls (rows, pending changes, apply), and the chip.
 */
export function Toolbar({
  connection,
  tabId,
}: {
  connection: ConnectionSummary | undefined;
  tabId: string;
}) {
  const shortcutOf = useShortcutOf();
  const t = useT();
  const sidebarCollapsed = useLayoutStore((store) => store.panels.sidebar.collapsed);
  const bottomCollapsed = useLayoutStore((store) => store.panels.bottom.collapsed);
  const table = useTabsStore((store) => store.tabs.some((tab) => tab.id === tabId && !!tab.table));
  const ddl = useTabsStore((store) => store.tabs.find((tab) => tab.id === tabId)?.ddl);

  return (
    <div className={styles.toolbar} role="toolbar" aria-label={t('toolbar.label')}>
      <IconButton
        icon="panelLeft"
        label={sidebarCollapsed ? t('toolbar.showSidebar') : t('toolbar.hideSidebar')}
        shortcut={shortcutOf('view.toggleSidebar')}
        aria-pressed={!sidebarCollapsed}
        onClick={() => {
          useLayoutStore.getState().togglePanel('sidebar');
        }}
      />
      <span className={styles.separator} aria-hidden="true" />
      {connection && table ? (
        <TableControls tabId={tabId} connection={connection} />
      ) : connection && ddl ? (
        <DdlControls target={ddl} connection={connection} />
      ) : connection ? (
        <QueryControls tabId={tabId} connection={connection} />
      ) : (
        <span className={styles.noConnection}>{t('toolbar.noConnection')}</span>
      )}
      <span className={styles.spacer} />
      <IconButton
        icon="panelBottom"
        label={bottomCollapsed ? t('toolbar.showLog') : t('toolbar.hideLog')}
        shortcut={shortcutOf('view.toggleStatementLog')}
        aria-pressed={!bottomCollapsed}
        onClick={() => {
          useLayoutStore.getState().togglePanel('bottom');
        }}
      />
    </div>
  );
}
