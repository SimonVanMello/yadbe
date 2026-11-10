import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { connectTo } from '../../features/connections/connectionActions';
import { ConnectionChip } from '../../features/connections/ConnectionChip';
import {
  stateOf,
  useConnection,
  useConnectionList,
  useSessions,
} from '../../features/connections/connectionStore';
import { ErrorPanel } from '../errors/ErrorPanel';
import styles from './QueryTabBody.module.css';
import { useTabsStore, type ShellTab } from './tabsStore';

/**
 * Body of a query tab. The editor and the result grid arrive with M1; until then the tab shows
 * the connection it is bound to and lets the user (re)connect.
 */
export function QueryTabBody({ tab }: { tab: ShellTab }) {
  const t = useT();
  const list = useConnectionList();
  const connection = useConnection(tab.connectionId);
  const session = useSessions((store) =>
    tab.connectionId === null ? undefined : store.sessions[tab.connectionId],
  );
  const error = useSessions((store) =>
    tab.connectionId === null ? undefined : store.errors[tab.connectionId],
  );
  const state = stateOf(session);

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

  const retry = () => {
    void connectTo(connection);
  };

  return (
    <div className={styles.body}>
      <ConnectionChip connection={connection} state={state} size="md" />
      <h2 className={styles.title}>{t('tab.query', { number: tab.ordinal })}</h2>
      {(state === 'connecting' || state === 'reconnecting') && (
        <p className={styles.status} role="status">
          <Spinner />
          {state === 'reconnecting' && session?.reconnectAttempt
            ? t('connection.state.reconnectingAttempt', { attempt: session.reconnectAttempt })
            : t(`connection.state.${state}`)}
        </p>
      )}
      {state === 'connected' && <p className={styles.hint}>{t('tab.body.empty')}</p>}
      {(state === 'disconnected' || state === 'lost') && (
        <>
          {error ? (
            <div className={styles.error}>
              <ErrorPanel
                compact
                title={
                  state === 'lost'
                    ? t('connection.state.lost')
                    : t('connection.connectFailed', { name: connection.name })
                }
                error={error}
                context={{
                  retry,
                  reconnect: retry,
                  connectionId: connection.id,
                }}
              />
            </div>
          ) : (
            <p className={styles.hint}>
              {state === 'lost' ? t('tab.body.lost') : t('tab.body.disconnected')}
            </p>
          )}
          <Button variant="primary" onClick={retry}>
            <Icon name="play" />
            {t('connection.menu.connect')}
          </Button>
        </>
      )}
    </div>
  );
}
