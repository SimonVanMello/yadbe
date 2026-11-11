import type { ReactElement } from 'react';

import { useT } from '../../i18n/useT';
import { openImport } from '../import/importStore';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { ContextMenuSub } from '../../ui/ContextMenuSub';
import {
  copyName,
  copyQualifiedName,
  databaseOf,
  metaNodeOf,
  newQuery,
  openTable,
  refreshNode,
  scriptAs,
} from './explorerActions';
import { explorerRowLabel } from './explorerLabels';
import type { ExplorerRow } from './explorerRows';

interface ExplorerContextMenuProps {
  row: ExplorerRow;
  /** The element that opens the menu on right click; must accept a ref. */
  children: ReactElement;
}

/** Context menu of an explorer row (F-023): new query, script as, copy, refresh. */
export function ExplorerContextMenu({ row, children }: ExplorerContextMenuProps) {
  const t = useT();
  const node = metaNodeOf(row);
  // A loading or failed row has the retry button and nothing else to offer.
  if (row.type === 'status' || node === null) return children;
  const { connectionId } = row;
  const table = row.type === 'object' && row.expandable ? row.ref : null;
  const scripts = row.type === 'object' && row.object.kind === 'table';
  const name = explorerRowLabel(row, t);
  const copyable = row.type !== 'kind' && row.type !== 'detailGroup';

  return (
    <ContextMenu
      content={
        <>
          <ContextMenuItem
            icon="plus"
            onSelect={() => {
              newQuery(connectionId, databaseOf(row));
            }}
          >
            {t('explorer.menu.newQuery')}
          </ContextMenuItem>
          {table && (
            <>
              <ContextMenuItem
                icon="table"
                onSelect={() => {
                  void openTable(connectionId, table);
                }}
              >
                {t('explorer.menu.openData')}
              </ContextMenuItem>
              {scripts && (
                <ContextMenuItem
                  icon="arrowUp"
                  onSelect={() => {
                    openImport(connectionId, table);
                  }}
                >
                  {t('explorer.menu.import')}
                </ContextMenuItem>
              )}
              <ContextMenuSub label={t('explorer.menu.scriptAs')} icon="terminal">
                <ContextMenuItem
                  onSelect={() => {
                    void scriptAs(connectionId, table, 'select');
                  }}
                >
                  {t('explorer.menu.script.select')}
                </ContextMenuItem>
                {scripts && (
                  <>
                    <ContextMenuItem
                      onSelect={() => {
                        void scriptAs(connectionId, table, 'insert');
                      }}
                    >
                      {t('explorer.menu.script.insert')}
                    </ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => {
                        void scriptAs(connectionId, table, 'update');
                      }}
                    >
                      {t('explorer.menu.script.update')}
                    </ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => {
                        void scriptAs(connectionId, table, 'delete');
                      }}
                    >
                      {t('explorer.menu.script.delete')}
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuSub>
            </>
          )}
          {copyable && <ContextMenuSeparator />}
          {copyable && (
            <ContextMenuItem
              icon="copy"
              onSelect={() => {
                void copyName(row.type === 'object' ? row.object.name : name);
              }}
            >
              {t('explorer.menu.copyName')}
            </ContextMenuItem>
          )}
          {table && (
            <ContextMenuItem
              icon="copy"
              onSelect={() => {
                void copyQualifiedName(connectionId, table);
              }}
            >
              {t('explorer.menu.copyQualifiedName')}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            icon="retry"
            shortcut="F5"
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
