import { useT } from '../../i18n/useT';
import { IconButton } from '../../ui/IconButton';
import { ConnectionChip } from '../connections/ConnectionChip';
import { useConnectionState } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import { cancelCollection, fetchPage, openCollection } from './collectionActions';
import { useCollectionTab } from './collectionStore';
import styles from './DocumentControls.module.css';

/** The collection-tab part of the toolbar: read the page again, stop a read, the chip. */
export function CollectionControls({
  tabId,
  connection,
}: {
  tabId: string;
  connection: ConnectionSummary;
}) {
  const t = useT();
  const state = useConnectionState(connection.id);
  const { page, loading, counting, phase } = useCollectionTab(tabId);
  return (
    <>
      <span className={styles.group} role="group" aria-label={t('mongo.collection.toolbar')}>
        <IconButton
          icon="retry"
          label={t('mongo.collection.refresh')}
          disabled={state !== 'connected' || loading}
          onClick={() => {
            if (phase !== 'ready' || !page) void openCollection(tabId);
            else void fetchPage(tabId, page.page);
          }}
        />
        <IconButton
          icon="stop"
          label={t('mongo.cancel')}
          disabled={!loading && !counting}
          onClick={() => {
            cancelCollection(tabId);
          }}
        />
      </span>
      <span className={styles.separator} aria-hidden="true" />
      <ConnectionChip connection={connection} state={state} />
    </>
  );
}
