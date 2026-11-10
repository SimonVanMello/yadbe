import type { ReactElement } from 'react';

import { useShellStore } from '../../app/shellStore';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { ContextMenuSub } from '../../ui/ContextMenuSub';
import {
  connectTo,
  deleteConnection,
  disconnectFrom,
  duplicateConnection,
  moveToGroup,
  openQuery,
  toggleFavorite,
} from './connectionActions';
import { useConnectionList, useConnectionState } from './connectionStore';
import type { ConnectionSummary } from './model';

interface ConnectionContextMenuProps {
  connection: ConnectionSummary;
  /** The element that opens the menu on right click; must accept a ref. */
  children: ReactElement;
}

/** Context menu of a saved connection (F-007), shared by the sidebar and the welcome screen. */
export function ConnectionContextMenu({ connection, children }: ConnectionContextMenuProps) {
  const t = useT();
  const state = useConnectionState(connection.id);
  const groups = useConnectionList().data?.groups ?? [];
  const connected = state === 'connected' || state === 'connecting';

  return (
    <ContextMenu
      content={
        <>
          {connected ? (
            <ContextMenuItem
              icon="stop"
              onSelect={() => {
                void disconnectFrom(connection);
              }}
            >
              {t('connection.menu.disconnect')}
            </ContextMenuItem>
          ) : (
            <ContextMenuItem
              icon="play"
              onSelect={() => {
                void connectTo(connection);
              }}
            >
              {t('connection.menu.connect')}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            icon="plus"
            onSelect={() => {
              openQuery(connection, { newTab: true });
            }}
          >
            {t('connection.menu.newQuery')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon="pencil"
            onSelect={() => {
              useShellStore.getState().openConnectionDialog({ connectionId: connection.id });
            }}
          >
            {t('connection.menu.edit')}
          </ContextMenuItem>
          <ContextMenuItem
            icon="copy"
            onSelect={() => {
              void duplicateConnection(connection);
            }}
          >
            {t('connection.menu.duplicate')}
          </ContextMenuItem>
          <ContextMenuItem
            icon="star"
            onSelect={() => {
              void toggleFavorite(connection);
            }}
          >
            {connection.favorite ? t('connection.menu.unfavorite') : t('connection.menu.favorite')}
          </ContextMenuItem>
          <ContextMenuSub label={t('connection.menu.moveToGroup')} icon="folder">
            <ContextMenuItem
              disabled={connection.groupId === null}
              onSelect={() => {
                void moveToGroup(connection, null);
              }}
            >
              {t('connection.menu.noGroup')}
            </ContextMenuItem>
            {groups.map((group) => (
              <ContextMenuItem
                key={group.id}
                disabled={connection.groupId === group.id}
                onSelect={() => {
                  void moveToGroup(connection, group.id);
                }}
              >
                {group.name}
              </ContextMenuItem>
            ))}
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon="trash"
            danger
            onSelect={() => {
              const tabCount = useTabsStore
                .getState()
                .tabs.filter((tab) => tab.connectionId === connection.id).length;
              void deleteConnection(connection, tabCount);
            }}
          >
            {t('connection.menu.delete')}
          </ContextMenuItem>
        </>
      }
    >
      {children}
    </ContextMenu>
  );
}
