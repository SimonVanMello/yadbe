import type { ReactNode } from 'react';

import { useTabsStore, type ShellTab } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { connectTo } from '../connections/connectionActions';
import { ConnectionChip } from '../connections/ConnectionChip';
import {
  useConnection,
  useConnectionList,
  useConnectionState,
} from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import styles from './ToolTabGuard.module.css';

interface ToolTabGuardProps {
  tab: ShellTab;
  /** What the tab is about, above the invitation to connect. */
  title: string;
  /** What to say when the connection is not open. */
  needsConnection: string;
  children: (connection: ConnectionSummary) => ReactNode;
}

/**
 * What a tool tab (activity monitor, migrations) shows while there is nothing to read: a
 * connection that was deleted, or one that is not open. Once connected, the body takes over.
 */
export function ToolTabGuard({ tab, title, needsConnection, children }: ToolTabGuardProps) {
  const t = useT();
  const list = useConnectionList();
  const connection = useConnection(tab.connectionId);
  const state = useConnectionState(tab.connectionId);

  if (!connection) {
    if (list.isPending) {
      return (
        <div className={styles.placeholder}>
          <Spinner />
        </div>
      );
    }
    return (
      <div className={styles.placeholder}>
        <Icon name="warning" size="lg" className={styles.warning} />
        <p className={styles.title}>{t('tab.body.missing')}</p>
        <Button
          onClick={() => {
            useTabsStore.getState().closeTab(tab.id);
          }}
        >
          {t('tab.menu.close')}
        </Button>
      </div>
    );
  }

  if (state !== 'connected') {
    const busy = state === 'connecting' || state === 'reconnecting';
    return (
      <div className={styles.placeholder}>
        <ConnectionChip connection={connection} state={state} size="md" />
        <p className={styles.title}>{title}</p>
        <p className={styles.text}>{needsConnection}</p>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => {
            void connectTo(connection);
          }}
        >
          {busy ? <Spinner /> : <Icon name="database" />}
          {t('tableData.connect')}
        </Button>
      </div>
    );
  }

  return <>{children(connection)}</>;
}
