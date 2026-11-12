import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { useConnection, useConnectionList } from '../../features/connections/connectionStore';
import { QueryView } from '../../features/query/QueryView';
import styles from './QueryTabBody.module.css';
import { LazyKvConsole } from '../lazyViews';
import { useTabsStore, type ShellTab } from './tabsStore';

/**
 * Body of a query tab: the editor and results of the connection's engine family (`QueryView`
 * for SQL), or what is left to say when the connection of the tab is still loading or was
 * deleted behind its back. Its toolbar follows the same family (`QueryTabControls`).
 */
export function QueryTabBody({ tab }: { tab: ShellTab }) {
  const t = useT();
  const list = useConnectionList();
  const connection = useConnection(tab.connectionId);

  if (!connection) {
    // The list is still loading, or the connection was deleted behind this tab's back.
    if (list.isPending) {
      return (
        <div className={styles.body}>
          <Spinner />
        </div>
      );
    }
    return (
      <div className={styles.body}>
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

  // A family gets its query tab (editor language, run action, results) by adding its case here.
  switch (connection.family) {
    case 'sql':
      return <QueryView tab={tab} connection={connection} />;
    case 'keyValue':
      return <LazyKvConsole tab={tab} connection={connection} />;
    default:
      return null;
  }
}
