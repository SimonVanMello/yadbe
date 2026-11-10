import { useEffect } from 'react';

import { useConnection } from '../features/connections/connectionStore';
import { useT } from '../i18n/useT';
import { nativeWindow } from '../ipc/nativeWindow';
import { selectActiveTab, useTabsStore } from './tabs/tabsStore';
import { windowTitle } from './windowTitle';

/** Keeps the OS window title (taskbar, window switcher) on the active tab. */
export function useWindowTitle(): void {
  const t = useT();
  const tab = useTabsStore(selectActiveTab);
  const connection = useConnection(tab.connectionId);
  const tabName = tab.connectionId === null ? null : t('tab.query', { number: tab.ordinal });
  const connectionName = connection?.name ?? null;
  useEffect(() => {
    void nativeWindow
      .setTitle(windowTitle({ tab: tabName, connection: connectionName }))
      .catch((error: unknown) => {
        console.warn('Could not set the window title', error);
      });
  }, [tabName, connectionName]);
}
