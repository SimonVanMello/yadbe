import type { ReactElement } from 'react';

import { useShellStore } from '../../app/shellStore';
import { useTabsStore } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { ContextMenuSub } from '../../ui/ContextMenuSub';
import { openActivity } from '../activity/activityActions';
import { refreshNode } from '../explorer/explorerActions';
import {
  connectTo,
  deleteConnection,
  disconnectFrom,
  duplicateConnection,
  moveToGroup,
  openQuery,
  toggleFavorite,
} from './connectionActions';
import { copyConnectionString } from './connectionStringActions';
import { useConnectionList, useConnectionState, useEngineInfo } from './connectionStore';
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
  const engine = useEngineInfo(connection.engine);
  const sessions = engine?.capabilities.activityMonitor ?? true;
  // A file database has no password to copy.
  const hasPassword = !(engine?.capabilities.usesFile ?? false);
  const dotnet = engine?.capabilities.dotnetConnectionString ?? true;

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
          {state === 'connected' && (
            <ContextMenuItem
              icon="retry"
              onSelect={() => {
                void refreshNode(connection.id, { level: 'connection' });
              }}
            >
              {t('explorer.menu.refresh')}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            icon="activity"
            disabled={!sessions}
            onSelect={() => {
              openActivity(connection.id);
            }}
          >
            {sessions
              ? t('connection.menu.activity')
              : t('connection.menu.activityDisabled', { engine: engine?.label ?? '' })}
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
          {dotnet && (
            <ContextMenuSub label={t('connection.menu.copyAs')} icon="copy">
              <ContextMenuItem
                onSelect={() => {
                  void copyConnectionString(connection, 'adoNet', false);
                }}
              >
                {t('connection.menu.adoNet')}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  void copyConnectionString(connection, 'efCore', false);
                }}
              >
                {t('connection.menu.efCore')}
              </ContextMenuItem>
              {hasPassword && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onSelect={() => {
                      void copyConnectionString(connection, 'adoNet', true);
                    }}
                  >
                    {t('connection.menu.adoNetPassword')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => {
                      void copyConnectionString(connection, 'efCore', true);
                    }}
                  >
                    {t('connection.menu.efCorePassword')}
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuSub>
          )}
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
