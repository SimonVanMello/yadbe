import type { ReactElement } from 'react';

import { useT } from '../../i18n/useT';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import {
  copyName,
  databaseOf,
  metaNodeOf,
  newQuery,
  openTable,
  refreshNode,
} from './explorerActions';
import { explorerRowLabel } from './explorerLabels';
import type { ExplorerRow } from './explorerRows';

interface DocumentContextMenuProps {
  row: ExplorerRow;
  children: ReactElement;
}

/**
 * Context menu of a row of a document connection's explorer: open the collection, a new console
 * on its database, copy the name (or a field's path), refresh.
 */
export function DocumentContextMenu({ row, children }: DocumentContextMenuProps) {
  const t = useT();
  const node = metaNodeOf(row);
  if (row.type === 'status' || node === null) return children;
  const { connectionId } = row;
  const name = row.type === 'docField' ? row.field.path : explorerRowLabel(row, t);
  return (
    <ContextMenu
      content={
        <>
          {row.type === 'docCollection' && (
            <ContextMenuItem
              icon="table"
              onSelect={() => {
                void openTable(connectionId, {
                  database: row.database,
                  schema: null,
                  name: row.collection.name,
                });
              }}
            >
              {t('mongo.menu.open')}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            icon="terminal"
            onSelect={() => {
              newQuery(connectionId, databaseOf(row));
            }}
          >
            {t('mongo.menu.newConsole')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {row.type !== 'docGroup' && (
            <ContextMenuItem
              icon="copy"
              onSelect={() => {
                void copyName(name);
              }}
            >
              {row.type === 'docField' ? t('mongo.menu.copyPath') : t('explorer.menu.copyName')}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            icon="retry"
            onSelect={() => {
              void refreshNode(connectionId, node);
            }}
          >
            {row.type === 'docGroup' && row.group === 'fields'
              ? t('mongo.menu.resample')
              : t('explorer.menu.refresh')}
          </ContextMenuItem>
        </>
      }
    >
      {children}
    </ContextMenu>
  );
}
