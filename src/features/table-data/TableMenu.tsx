import { runAction, shortcutOf } from '../../app/actions';
import { useT } from '../../i18n/useT';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import {
  deleteSelectedRows,
  duplicateRows,
  insertRow,
  revertSelectedCells,
  revertSelectedRows,
  setNullOnSelection,
} from './tableActions';
import { usePendingCount } from './tableSessionStore';

/** The table entries of the grid's context menu (F-082 to F-084). */
export function TableMenu({ tabId, editable }: { tabId: string; editable: boolean }) {
  const t = useT();
  const pending = usePendingCount(tabId) > 0;
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem
        shortcut={shortcutOf('table.setNull')}
        disabled={!editable}
        onSelect={() => {
          void setNullOnSelection(tabId);
        }}
      >
        {t('tableData.menu.setNull')}
      </ContextMenuItem>
      <ContextMenuItem
        icon="plus"
        shortcut={shortcutOf('table.insertRow')}
        disabled={!editable}
        onSelect={() => {
          insertRow(tabId);
        }}
      >
        {t('action.table.insertRow')}
      </ContextMenuItem>
      <ContextMenuItem
        icon="copy"
        shortcut={shortcutOf('table.duplicateRows')}
        disabled={!editable}
        onSelect={() => {
          void duplicateRows(tabId);
        }}
      >
        {t('action.table.duplicateRows')}
      </ContextMenuItem>
      <ContextMenuItem
        shortcut="Mod+Shift+V"
        disabled={!editable}
        onSelect={() => {
          runAction('table.pasteRows');
        }}
      >
        {t('action.table.pasteRows')}
      </ContextMenuItem>
      <ContextMenuItem
        icon="trash"
        danger
        shortcut={shortcutOf('table.deleteRows')}
        disabled={!editable}
        onSelect={() => {
          void deleteSelectedRows(tabId);
        }}
      >
        {t('action.table.deleteRows')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        icon="undo"
        disabled={!pending}
        onSelect={() => {
          revertSelectedCells(tabId);
        }}
      >
        {t('action.table.revertCells')}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!pending}
        onSelect={() => {
          revertSelectedRows(tabId);
        }}
      >
        {t('action.table.revertRows')}
      </ContextMenuItem>
    </>
  );
}
