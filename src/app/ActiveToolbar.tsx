import { useConnection } from '../features/connections/connectionStore';
import { Toolbar } from '../features/toolbar/Toolbar';
import { selectActiveTab, useTabsStore } from './tabs/tabsStore';

/**
 * The toolbar of the active tab, if it is bound to a connection. It follows the active tab on
 * its own, so that a tab switch re-renders this and not the whole shell.
 */
export function ActiveToolbar() {
  const tabId = useTabsStore((state) => selectActiveTab(state).id);
  const connectionId = useTabsStore((state) => selectActiveTab(state).connectionId);
  const connection = useConnection(connectionId);
  if (connectionId === null) return null;
  return <Toolbar connection={connection} tabId={tabId} />;
}
