import { useDeferredValue, useRef, useState } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useShellStore } from '../../app/shellStore';
import { useT } from '../../i18n/useT';
import { YadbeIpcError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Spinner } from '../../ui/Spinner';
import { TextInput } from '../../ui/TextInput';
import { openQuery } from '../connections/connectionActions';
import { refreshConnections, useConnectionList } from '../connections/connectionStore';
import { useGroupDialog } from '../connections/groupDialogStore';
import { useExplorerStore } from '../explorer/explorerStore';
import { useRevealStore } from '../explorer/revealStore';
import styles from './ConnectionSidebar.module.css';
import { SidebarTree } from './SidebarTree';
import { useSidebarRows } from './useSidebarRows';

/** Connection list and explorer of the sidebar (F-007, F-020 to F-023). */
export function ConnectionSidebar() {
  const t = useT();
  const list = useConnectionList();
  const [query, setQuery] = useState('');
  const treeRef = useRef<HTMLDivElement>(null);
  // Typing stays instant; the tree follows when it can.
  const rows = useSidebarRows(useDeferredValue(query));
  const showSystem = useExplorerStore((store) => store.showSystem);
  const searching = query.trim() !== '';
  // A filter would hide the row an explorer reveal looks for.
  const revealSeq = useRevealStore((store) => store.request?.seq ?? 0);
  const [seenReveal, setSeenReveal] = useState(revealSeq);
  if (revealSeq !== seenReveal) {
    setSeenReveal(revealSeq);
    setQuery('');
  }

  return (
    <aside className={styles.sidebar} aria-label={t('sidebar.connections')}>
      <div className={styles.header}>
        <h2 className={styles.title}>{t('sidebar.connections')}</h2>
        <div className={styles.actions}>
          <IconButton
            icon={showSystem ? 'eye' : 'eyeOff'}
            size="sm"
            label={showSystem ? t('explorer.hideSystem') : t('explorer.showSystem')}
            aria-pressed={showSystem}
            onClick={() => {
              useExplorerStore.getState().setShowSystem(!showSystem);
            }}
          />
          <IconButton
            icon="folder"
            size="sm"
            label={t('group.new.title')}
            onClick={() => {
              useGroupDialog.getState().open({});
            }}
          />
          <IconButton
            icon="plus"
            size="sm"
            label={t('connection.new')}
            onClick={() => {
              useShellStore.getState().openConnectionDialog({ connectionId: null });
            }}
          />
        </div>
      </div>
      <div className={styles.filter}>
        <Icon name="search" className={styles.filterIcon} />
        <TextInput
          className={styles.filterInput}
          value={query}
          placeholder={t('sidebar.filter')}
          aria-label={t('sidebar.filter')}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('');
            else if (event.key === 'ArrowDown' && rows.length > 0) {
              event.preventDefault();
              treeRef.current?.focus();
            } else if (event.key === 'Enter' && searching) {
              const first = rows.find((row) => row.type === 'connection');
              if (first?.type === 'connection') openQuery(first.connection);
            }
          }}
        />
      </div>
      {list.isPending && (
        <div className={styles.state}>
          <Spinner />
        </div>
      )}
      {list.isError && (
        <div className={styles.error}>
          {list.error instanceof YadbeIpcError ? (
            <ErrorPanel
              compact
              title={t('sidebar.loadFailed')}
              error={list.error.error}
              context={{
                retry: () => {
                  void refreshConnections();
                },
              }}
            />
          ) : (
            <p className={styles.empty}>{t('sidebar.loadFailed')}</p>
          )}
        </div>
      )}
      {list.isSuccess && (
        <SidebarTree
          rows={rows}
          label={t('sidebar.connections')}
          treeRef={treeRef}
          empty={
            <div className={styles.state}>
              {searching ? (
                <p className={styles.empty}>{t('sidebar.noMatch')}</p>
              ) : (
                <>
                  <p className={styles.empty}>{t('sidebar.empty')}</p>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      useShellStore.getState().openConnectionDialog({ connectionId: null });
                    }}
                  >
                    {t('connection.new')}
                  </Button>
                </>
              )}
            </div>
          }
        />
      )}
    </aside>
  );
}
