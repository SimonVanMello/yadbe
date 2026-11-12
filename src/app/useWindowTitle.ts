import { useEffect } from 'react';

import { useConnection } from '../features/connections/connectionStore';
import { ddlTargetName } from '../features/objects/objectsModel';
import { useTabFileName } from '../features/query/queryTabStore';
import { toolTabName } from '../features/tools/toolTabs';
import { useT } from '../i18n/useT';
import { nativeWindow } from '../ipc/nativeWindow';
import { selectActiveTab, useTabsStore } from './tabs/tabsStore';
import { windowTitle } from './windowTitle';

/** Keeps the OS window title (taskbar, window switcher) on the active tab. */
export function useWindowTitle(): void {
  const t = useT();
  const tab = useTabsStore(selectActiveTab);
  const connection = useConnection(tab.connectionId);
  const fileName = useTabFileName(tab.id);
  const tabName =
    tab.connectionId === null
      ? null
      : tab.table
        ? tab.table.name
        : tab.ddl
          ? ddlTargetName(tab.ddl)
          : tab.tool
            ? toolTabName(tab.tool, t)
            : (fileName ?? t('tab.query', { number: tab.ordinal }));
  const connectionName = connection?.name ?? null;
  useEffect(() => {
    void nativeWindow
      .setTitle(windowTitle({ tab: tabName, connection: connectionName }))
      .catch((error: unknown) => {
        console.warn('Could not set the window title', error);
      });
  }, [tabName, connectionName]);
}
