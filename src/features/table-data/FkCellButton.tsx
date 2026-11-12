import { useShortcutOf } from '../../app/useShortcutOf';
import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';
import type { GridCellRef } from '../grid/DataGrid';
import { peekReference } from './fkNavigation';
import styles from './ForeignKeys.module.css';

interface FkCellButtonProps {
  tabId: string;
  cell: GridCellRef;
  /** The referenced table, as the user reads it. */
  table: string;
}

/**
 * The button at the end of a foreign key cell under the pointer or focused (F-088): it shows
 * the referenced row. The keyboard has `Alt+F12` (and `F12` to jump), so it stays out of the
 * tab order.
 */
export function FkCellButton({ tabId, cell, table }: FkCellButtonProps) {
  const shortcutOf = useShortcutOf();
  const t = useT();
  const label = t('tableData.fk.badge', { table });
  return (
    <Tooltip content={label} shortcut={shortcutOf('table.peekReference')}>
      <button
        type="button"
        tabIndex={-1}
        className={styles.cellButton}
        aria-label={label}
        data-testid="fk-cell-button"
        onClick={() => {
          void peekReference(tabId, cell);
        }}
      >
        <Icon name="link" />
      </button>
    </Tooltip>
  );
}
