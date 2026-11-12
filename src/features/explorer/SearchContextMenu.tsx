import type { ReactElement } from 'react';

import { useT } from '../../i18n/useT';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { openQueryTab } from '../query/openQueryTab';
import { copyName, metaNodeOf, openTable, refreshNode } from './explorerActions';
import { explorerRowLabel } from './explorerLabels';
import type { ExplorerRow } from './explorerRows';
import { isSearchBody, searchStarter, searchTargetOf } from './searchRows';

interface SearchContextMenuProps {
  row: ExplorerRow;
  children: ReactElement;
}

/**
 * Context menu of a row of a search connection's explorer: open the index (data stream,
 * alias) in an index tab, a new console on it, copy the name (or a field's path), refresh.
 */
export function SearchContextMenu({ row, children }: SearchContextMenuProps) {
  const t = useT();
  const node = metaNodeOf(row);
  if (row.type === 'status' || node === null || !isSearchBody(row)) return children;
  const { connectionId } = row;
  const target = searchTargetOf(row);
  const named = row.type !== 'searchGroup' && row.type !== 'searchDetails';
  return (
    <ContextMenu
      content={
        <>
          {target !== null && (
            <ContextMenuItem
              icon="table"
              onSelect={() => {
                void openTable(connectionId, { database: '', schema: null, name: target });
              }}
            >
              {t('search.menu.open')}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            icon="terminal"
            onSelect={() => {
              openQueryTab({
                connectionId,
                database: null,
                ...(target === null ? {} : { initialText: searchStarter(target) }),
              });
            }}
          >
            {t('search.menu.newConsole')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {named && (
            <ContextMenuItem
              icon="copy"
              onSelect={() => {
                void copyName(explorerRowLabel(row, t));
              }}
            >
              {row.type === 'searchField' ? t('search.menu.copyPath') : t('explorer.menu.copyName')}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            icon="retry"
            onSelect={() => {
              void refreshNode(connectionId, node);
            }}
          >
            {t('explorer.menu.refresh')}
          </ContextMenuItem>
        </>
      }
    >
      {children}
    </ContextMenu>
  );
}
