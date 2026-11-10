import { useEffect } from 'react';

import { useTabsStore, type ShellTab } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import type { ObjectRef } from '../../ipc';
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
import { openTable } from './tableActions';
import { tableLabel } from './tableNames';
import styles from './TableView.module.css';
import { useTableSession, useTableSessionStore } from './tableSessionStore';
import { TableView } from './TableView';

/**
 * Body of a table tab (F-080): its rows once the connection is open. A restored tab does not
 * connect by itself; it says so and offers to. The table is described again whenever the
 * connection comes back (the backend's tab connection went with it).
 */
export function TableTabBody({ tab, table }: { tab: ShellTab; table: ObjectRef }) {
  const t = useT();
  const list = useConnectionList();
  const connection = useConnection(tab.connectionId);
  const state = useConnectionState(tab.connectionId);
  const { phase } = useTableSession(tab.id);
  const connected = state === 'connected';

  useEffect(() => {
    if (!connected) {
      // The backend forgot the tab with the connection: describe it again when it is back.
      if (useTableSessionStore.getState().sessions[tab.id]?.phase === 'ready') {
        useTableSessionStore.getState().patch(tab.id, { phase: 'idle' });
      }
      return;
    }
    if (phase === 'idle') void openTable(tab.id);
  }, [connected, phase, tab.id]);

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
        <p className={styles.placeholderTitle}>{t('tab.body.missing')}</p>
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

  if (!connected && phase !== 'ready') {
    const busy = state === 'connecting' || state === 'reconnecting';
    return (
      <div className={styles.placeholder}>
        <ConnectionChip connection={connection} state={state} size="md" />
        <p className={styles.placeholderTitle}>{tableLabel(table)}</p>
        <p className={styles.placeholderText}>{t('tableData.connectFirst')}</p>
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

  return <TableView tabId={tab.id} table={table} connection={connection} />;
}
