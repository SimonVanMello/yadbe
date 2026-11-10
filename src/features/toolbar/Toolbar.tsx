import { shortcutOf } from '../../app/actions';
import { useLayoutStore } from '../../app/layout/layoutStore';
import { useT } from '../../i18n/useT';
import { IconButton } from '../../ui/IconButton';
import type { ConnectionSummary } from '../connections/model';
import { QueryControls } from '../query/QueryControls';
import styles from './Toolbar.module.css';

/** Toolbar of a query tab: panels, the query controls (run, transactions, files), the chip. */
export function Toolbar({
  connection,
  tabId,
}: {
  connection: ConnectionSummary | undefined;
  tabId: string;
}) {
  const t = useT();
  const sidebarCollapsed = useLayoutStore((store) => store.panels.sidebar.collapsed);
  const bottomCollapsed = useLayoutStore((store) => store.panels.bottom.collapsed);

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
      {connection ? (
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
