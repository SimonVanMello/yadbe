import { useMemo, useRef, useState, type KeyboardEvent } from 'react';

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
import { buildSidebarRows, type SidebarRow } from '../connections/connectionRows';
import { refreshConnections, useConnectionList } from '../connections/connectionStore';
import { setGroupCollapsed } from '../connections/groupActions';
import { useGroupDialog } from '../connections/groupDialogStore';
import { ConnectionRow } from './ConnectionRow';
import styles from './ConnectionSidebar.module.css';
import { GroupRow } from './GroupRow';

const rowId = (row: SidebarRow) =>
  row.kind === 'group' ? `group:${row.group.id}` : `connection:${row.connection.id}`;

/** Connection list of the sidebar (F-007): folders, environment, state, favorites, filter. */
export function ConnectionSidebar() {
  const t = useT();
  const list = useConnectionList();
  const [focusedRow, setFocusedRow] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const treeRef = useRef<HTMLDivElement>(null);

  const connections = list.data?.connections;
  const groups = list.data?.groups;
  const rows = useMemo(
    () => (connections && groups ? buildSidebarRows(connections, groups, query) : []),
    [connections, groups, query],
  );
  const ids = rows.map(rowId);
  // Roving tabindex: the focused row, else the first, is the one Tab lands on.
  const tabStop = focusedRow !== null && ids.includes(focusedRow) ? focusedRow : (ids[0] ?? null);
  const searching = query.trim() !== '';

  const focusRow = (id: string | undefined) => {
    if (!id) return;
    treeRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)?.focus();
  };

  const onKeyDown = (row: SidebarRow, index: number) => (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        focusRow(ids[index + 1]);
        break;
      case 'ArrowUp':
        focusRow(ids[index - 1]);
        break;
      case 'Home':
        focusRow(ids[0]);
        break;
      case 'End':
        focusRow(ids.at(-1));
        break;
      case 'ArrowRight':
        if (row.kind !== 'group') return;
        if (!row.expanded) void setGroupCollapsed(row.group, false);
        else focusRow(ids[index + 1]);
        break;
      case 'ArrowLeft':
        if (row.kind === 'group') {
          if (row.expanded) void setGroupCollapsed(row.group, true);
        } else if (row.depth > 0) {
          const parent = rows
            .slice(0, index)
            .reverse()
            .find((r) => r.kind === 'group' && r.depth === row.depth - 1);
          focusRow(parent && rowId(parent));
        }
        break;
      case 'Enter':
      case ' ':
        if (row.kind === 'group') void setGroupCollapsed(row.group, row.expanded);
        else openQuery(row.connection);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <aside className={styles.sidebar} aria-label={t('sidebar.connections')}>
      <div className={styles.header}>
        <h2 className={styles.title}>{t('sidebar.connections')}</h2>
        <div className={styles.actions}>
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
            else if (event.key === 'ArrowDown' && ids[0]) {
              event.preventDefault();
              focusRow(ids[0]);
            } else if (event.key === 'Enter' && searching) {
              const first = rows.find((row) => row.kind === 'connection');
              if (first?.kind === 'connection') openQuery(first.connection);
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
        <div
          ref={treeRef}
          role="tree"
          aria-label={t('sidebar.connections')}
          className={styles.tree}
        >
          {rows.map((row, index) =>
            row.kind === 'group' ? (
              <GroupRow
                key={rowId(row)}
                group={row.group}
                expanded={row.expanded}
                count={row.count}
                depth={row.depth}
                focused={rowId(row) === tabStop}
                onFocus={() => {
                  setFocusedRow(rowId(row));
                }}
                onKeyDown={onKeyDown(row, index)}
              />
            ) : (
              <ConnectionRow
                key={rowId(row)}
                connection={row.connection}
                nameIndices={row.nameIndices}
                depth={row.depth}
                focused={rowId(row) === tabStop}
                onFocus={() => {
                  setFocusedRow(rowId(row));
                }}
                onKeyDown={onKeyDown(row, index)}
              />
            ),
          )}
          {rows.length === 0 && (
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
          )}
        </div>
      )}
    </aside>
  );
}
