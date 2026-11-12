import { useT } from '../../i18n/useT';
import { IconButton } from '../../ui/IconButton';
import { ConnectionChip } from '../connections/ConnectionChip';
import { useConnectionState } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import styles from '../document/DocumentControls.module.css';
import { cancelIndex, fetchIndexPage, openIndex } from './indexActions';
import { useIndexTab } from './indexStore';

/**
 * The index-tab part of the toolbar: read again from the first page (a fresh point in time),
 * stop a read or a count, the connection's chip.
 */
export function IndexControls({
  tabId,
  connection,
}: {
  tabId: string;
  connection: ConnectionSummary;
}) {
  const t = useT();
  const state = useConnectionState(connection.id);
  const { page, loading, counting, phase } = useIndexTab(tabId);
  return (
    <>
      <span className={styles.group} role="group" aria-label={t('search.index.toolbar')}>
        <IconButton
          icon="retry"
          label={t('search.index.refresh')}
          disabled={state !== 'connected' || loading}
          onClick={() => {
            if (phase !== 'ready' || !page) void openIndex(tabId);
            else void fetchIndexPage(tabId, 0);
          }}
        />
        <IconButton
          icon="stop"
          label={t('search.cancel')}
          disabled={!loading && !counting}
          onClick={() => {
            cancelIndex(tabId);
          }}
        />
      </span>
      <span className={styles.separator} aria-hidden="true" />
      <ConnectionChip connection={connection} state={state} />
    </>
  );
}
