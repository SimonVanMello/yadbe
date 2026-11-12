import { shortcutOf } from '../../app/actions';
import { useT } from '../../i18n/useT';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import {
  deleteSelectedRows,
  revertSelectedCells,
  revertSelectedRows,
  setNullOnSelection,
} from '../table-data/tableActions';
import { usePendingCount } from '../table-data/tableSessionStore';

/** The editing entries of an editable result's context menu (F-087): no inserts. */
export function ResultEditMenu({ sessionId }: { sessionId: string }) {
  const t = useT();
  const pending = usePendingCount(sessionId) > 0;
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem
        shortcut={shortcutOf('table.setNull')}
        onSelect={() => {
          void setNullOnSelection(sessionId);
        }}
      >
        {t('tableData.menu.setNull')}
      </ContextMenuItem>
      <ContextMenuItem
        icon="trash"
        danger
        shortcut={shortcutOf('table.deleteRows')}
        onSelect={() => {
          void deleteSelectedRows(sessionId);
        }}
      >
        {t('action.table.deleteRows')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        icon="undo"
        disabled={!pending}
        onSelect={() => {
          revertSelectedCells(sessionId);
        }}
      >
        {t('action.table.revertCells')}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!pending}
        onSelect={() => {
          revertSelectedRows(sessionId);
        }}
      >
        {t('action.table.revertRows')}
      </ContextMenuItem>
    </>
  );
}
