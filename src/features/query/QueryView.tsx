import { useEffect, useRef } from 'react';

import type { ShellTab } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { connectTo } from '../connections/connectionActions';
import { useConnectionState, useSession, useSessions } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { FileIssueBanner } from './FileIssueBanner';
import { restoreTab } from './executionStore';
import { checkExternalChange } from './queryActions';
import { QuerySplit } from './QuerySplit';
import { useQueryTabStore } from './queryTabStore';
import { useQueryUiStore } from './queryUiStore';
import styles from './QueryView.module.css';
import { ResultsArea } from './ResultsArea';
import { SqlEditor } from './SqlEditor';

/**
 * Body of a query tab (SPEC §4): the SQL editor on top, the results area below, a resizable and
 * remembered split between them. The execution state lives in `executionStore`, so switching
 * tabs and coming back shows the run as it is, and a remount after a reload restores it from the
 * backend (`getQueryTab`).
 */
export function QueryView({ tab, connection }: { tab: ShellTab; connection: ConnectionSummary }) {
  const ratio = useQueryUiStore((state) => state.resultsRatio);
  const container = useRef<HTMLDivElement>(null);

  // The editor state exists from the first mount on, restored tabs included.
  useEffect(() => {
    useQueryTabStore.getState().ensure(tab.id);
    void restoreTab(tab.id);
  }, [tab.id]);

  // No file watcher: the file is compared with what the tab holds when the tab comes forward and
  // when the window regains focus (F-045).
  useEffect(() => {
    void checkExternalChange(tab.id);
    const onFocus = () => {
      void checkExternalChange(tab.id);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [tab.id]);

  return (
    <div ref={container} className={styles.view}>
      <ConnectionNotice connection={connection} />
      <FileIssueBanner tabId={tab.id} />
      <div className={styles.editor}>
        <SqlEditor
          key={tab.id}
          tabId={tab.id}
          engine={connection.engine}
          connectionId={connection.id}
          connectionDatabase={connection.database}
        />
      </div>
      <QuerySplit container={container} />
      <div className={styles.results} style={{ flexBasis: `${String(ratio * 100)}%` }}>
        <ResultsArea tabId={tab.id} />
      </div>
    </div>
  );
}

/** A slim bar above the editor when the tab's connection is not open: the script stays editable. */
function ConnectionNotice({ connection }: { connection: ConnectionSummary }) {
  const t = useT();
  const state = useConnectionState(connection.id);
  const session = useSession(connection.id);
  const error = useSessions((store) => store.errors[connection.id]);
  if (state === 'connected') return null;

  if (state === 'connecting' || state === 'reconnecting') {
    return (
      <p className={styles.notice} role="status">
        <Spinner />
        {state === 'reconnecting' && session?.reconnectAttempt
          ? t('connection.state.reconnectingAttempt', { attempt: session.reconnectAttempt })
          : t(`connection.state.${state}`)}
      </p>
    );
  }
  const retry = () => {
    void connectTo(connection);
  };
  return (
    <div className={styles.notice} data-tone="warning" data-testid="connection-notice">
      {error ? (
        <div className={styles.noticeError}>
          <ErrorPanel
            compact
            title={
              state === 'lost'
                ? t('connection.state.lost')
                : t('connection.connectFailed', { name: connection.name })
            }
            error={error}
            context={{ retry, reconnect: retry, connectionId: connection.id }}
          />
        </div>
      ) : (
        <>
          <Icon name="warning" />
          <span className={styles.noticeText}>
            {state === 'lost' ? t('tab.body.lost') : t('tab.body.disconnected')}
          </span>
        </>
      )}
      <Button size="sm" variant="primary" onClick={retry}>
        <Icon name="play" />
        {t('connection.menu.connect')}
      </Button>
    </div>
  );
}
