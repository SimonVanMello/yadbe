import { useRef, type ReactElement } from 'react';

import { useT } from '../../i18n/useT';
import { openImport } from '../import/importStore';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { ContextMenuSub } from '../../ui/ContextMenuSub';
import { useConnection, useEngineInfo } from '../connections/connectionStore';
import { isEfHistoryTable } from '../migrations/historyTables';
import { openMigrations } from '../migrations/migrationsActions';
import { showDdl } from '../objects/ddlActions';
import { requestObjectAction } from '../objects/objectActions';
import { showProperties } from '../objects/propertiesStore';
import { startRename } from '../objects/renameStore';
import { ddlTargetForRow, objectSubject, pinForRow, toolsFor } from '../objects/rowTools';
import { isPinned, usePinStore } from '../objects/pinStore';
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
import { isRelationKind, type ExplorerRow } from './explorerRows';

interface ExplorerContextMenuProps {
  row: ExplorerRow;
  /** The element that opens the menu on right click; must accept a ref. */
  children: ReactElement;
}

/**
 * Context menu of an explorer row (F-023): new query, script as, copy, refresh; and the object
 * tools: definition, properties, pin, rename, truncate and drop (F-024 to F-027).
 */
export function ExplorerContextMenu({ row, children }: ExplorerContextMenuProps) {
  const t = useT();
  const connection = useConnection(row.connectionId);
  const engine = useEngineInfo(connection?.engine ?? null);
  const pins = usePinStore((state) => state.pins);
  // Rename waits for the menu to give the focus back, or the field would lose it at once.
  const renameOnClose = useRef(false);
  const node = metaNodeOf(row);
  // A loading or failed row has the retry button and nothing else to offer.
  if (row.type === 'status' || node === null) return children;
  const { connectionId } = row;
  const subject = objectSubject(row);
  const table = subject && isRelationKind(subject.kind) ? subject.object : null;
  const scripts = subject?.kind === 'table';
  const name = explorerRowLabel(row, t);
  const copyable = row.type !== 'kind' && row.type !== 'detailGroup';
  const ddlTarget = ddlTargetForRow(row);
  const pin = pinForRow(row);
  const pinned = pin !== null && isPinned(pins, pin);
  const tools = subject ? toolsFor(connection, engine, subject.kind) : null;
  const hasTools = tools !== null && (tools.rename || tools.truncate || tools.drop);
  const disabled = tools?.readOnly ?? false;
  const readOnlyHint = disabled ? t('explorer.menu.readOnly') : undefined;
  const act = (action: Parameters<typeof requestObjectAction>[4]) => {
    if (subject) {
      requestObjectAction(connectionId, subject.object, subject.kind, subject.id, action);
    }
  };

  return (
    <ContextMenu
      onCloseAutoFocus={(event) => {
        if (!renameOnClose.current) return;
        renameOnClose.current = false;
        event.preventDefault();
        startRename(row);
      }}
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
          {(ddlTarget || table || pin) && <ContextMenuSeparator />}
          {ddlTarget && (
            <ContextMenuItem
              icon="file"
              onSelect={() => {
                showDdl(connectionId, ddlTarget);
              }}
            >
              {t('explorer.menu.showDdl')}
            </ContextMenuItem>
          )}
          {subject && table && (
            <ContextMenuItem
              icon="info"
              onSelect={() => {
                showProperties(connectionId, subject.object, subject.kind);
              }}
            >
              {t('explorer.menu.properties')}
            </ContextMenuItem>
          )}
          {subject && subject.kind === 'table' && isEfHistoryTable(subject.object.name) && (
            <ContextMenuItem
              icon="timeline"
              onSelect={() => {
                openMigrations(connectionId, subject.object);
              }}
            >
              {t('explorer.menu.migrations')}
            </ContextMenuItem>
          )}
          {pin && (
            <ContextMenuItem
              icon="pin"
              onSelect={() => {
                void usePinStore.getState().toggle(pin);
              }}
            >
              {pinned ? t('explorer.menu.unpin') : t('explorer.menu.pin')}
            </ContextMenuItem>
          )}
          {hasTools && <ContextMenuSeparator />}
          {tools?.rename && (
            <ContextMenuItem
              icon="pencil"
              shortcut="F2"
              disabled={disabled}
              hint={readOnlyHint}
              onSelect={() => {
                renameOnClose.current = true;
              }}
            >
              {t('explorer.menu.rename')}
            </ContextMenuItem>
          )}
          {tools?.truncate && (
            <ContextMenuItem
              icon="minus"
              danger
              disabled={disabled}
              hint={tools.rename ? undefined : readOnlyHint}
              onSelect={() => {
                act({ type: 'truncate' });
              }}
            >
              {t('explorer.menu.truncate')}
            </ContextMenuItem>
          )}
          {tools?.drop && (
            <ContextMenuItem
              icon="trash"
              danger
              disabled={disabled}
              onSelect={() => {
                act({ type: 'drop' });
              }}
            >
              {t('explorer.menu.drop')}
            </ContextMenuItem>
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
