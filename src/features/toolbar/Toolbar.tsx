import { shortcutOf } from '../../app/actions';
import { useLayoutStore } from '../../app/layout/layoutStore';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Tooltip } from '../../ui/Tooltip';
import { ConnectionChip } from '../connections/ConnectionChip';
import { useConnectionState } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import styles from './Toolbar.module.css';

/** Toolbar of a query tab: Run / Cancel (placeholders until M1), the connection chip, panels. */
export function Toolbar({ connection }: { connection: ConnectionSummary | undefined }) {
  const t = useT();
  const state = useConnectionState(connection?.id ?? null);
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
      <Tooltip content={t('toolbar.run.soon')}>
        {/* A disabled button gets no pointer events: the wrapper carries the tooltip. */}
        <span className={styles.disabledWrap}>
          <Button variant="primary" size="sm" disabled>
            <Icon name="play" />
            {t('toolbar.run')}
          </Button>
        </span>
      </Tooltip>
      <Tooltip content={t('toolbar.cancel.soon')}>
        <span className={styles.disabledWrap}>
          <Button size="sm" disabled>
            <Icon name="stop" />
            {t('toolbar.cancel')}
          </Button>
        </span>
      </Tooltip>
      <span className={styles.separator} aria-hidden="true" />
      <div className={styles.chip}>
        {connection ? (
          <ConnectionChip connection={connection} state={state} />
        ) : (
          <span className={styles.noConnection}>{t('toolbar.noConnection')}</span>
        )}
      </div>
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
