import { useShortcutOf } from '../../app/useShortcutOf';
import { useT } from '../../i18n/useT';
import { IconButton } from '../../ui/IconButton';
import { ConnectionChip } from '../connections/ConnectionChip';
import { useConnectionState } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import { cancelCollection, fetchPage, openCollection } from './collectionActions';
import { openCollectionExport } from './collectionExport';
import { useCollectionTab } from './collectionStore';
import styles from './DocumentControls.module.css';

/**
 * The collection-tab part of the toolbar: read the page again, stop a read, export the
 * collection under the tab's query (in the grid and the documents view alike), the chip.
 */
export function CollectionControls({
  tabId,
  connection,
}: {
  tabId: string;
  connection: ConnectionSummary;
}) {
  const t = useT();
  const shortcutOf = useShortcutOf();
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
        <IconButton
          icon="download"
          label={t('action.collection.export')}
          shortcut={shortcutOf('result.export')}
          disabled={state !== 'connected' || phase !== 'ready'}
          onClick={() => {
            openCollectionExport(tabId);
          }}
        />
      </span>
      <span className={styles.separator} aria-hidden="true" />
      <ConnectionChip connection={connection} state={state} />
    </>
  );
}
