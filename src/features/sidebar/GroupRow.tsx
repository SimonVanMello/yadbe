import { memo, type CSSProperties } from 'react';

import { useShellStore } from '../../app/shellStore';
import { useT } from '../../i18n/useT';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { Icon } from '../../ui/Icon';
import { deleteGroup } from '../connections/groupActions';
import { useGroupDialog } from '../connections/groupDialogStore';
import styles from './GroupRow.module.css';
import { rowStyle } from './rowStyle';
import type { SidebarTreeRow } from './sidebarRows';

export type GroupTreeRow = Extract<SidebarTreeRow, { type: 'group' }>;

interface GroupRowProps {
  row: GroupTreeRow;
  id: string;
  index: number;
  active: boolean;
  posInSet: number;
  setSize: number;
  offset: number;
  height: number;
  onSelect: (index: number) => void;
  onToggle: (row: GroupTreeRow) => void;
}

/** A folder of the connection list (F-007): click to fold, right click to rename or delete. */
export const GroupRow = memo(function GroupRow({
  row,
  id,
  index,
  active,
  posInSet,
  setSize,
  offset,
  height,
  onSelect,
  onToggle,
}: GroupRowProps) {
  const t = useT();
  const { group, expanded, count } = row;
  return (
    <ContextMenu
      content={
        <>
          <ContextMenuItem
            icon="plus"
            onSelect={() => {
              useShellStore
                .getState()
                .openConnectionDialog({ connectionId: null, groupId: group.id });
            }}
          >
            {t('group.menu.newConnection')}
          </ContextMenuItem>
          <ContextMenuItem
            icon="folder"
            onSelect={() => {
              useGroupDialog.getState().open({ parentId: group.id });
            }}
          >
            {t('group.menu.newSubgroup')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon="pencil"
            onSelect={() => {
              useGroupDialog.getState().open({ group });
            }}
          >
            {t('group.menu.rename')}
          </ContextMenuItem>
          <ContextMenuItem
            icon="trash"
            danger
            onSelect={() => {
              void deleteGroup(group, count);
            }}
          >
            {t('group.menu.delete')}
          </ContextMenuItem>
        </>
      }
    >
      <div
        id={id}
        role="treeitem"
        aria-level={row.level}
        aria-posinset={posInSet}
        aria-setsize={setSize}
        aria-expanded={expanded}
        aria-selected={active}
        data-row-index={index}
        data-active={active || undefined}
        className={styles.row}
        style={{ ...rowStyle(offset, height), '--depth': row.level - 1 } as CSSProperties}
        onClick={() => {
          onSelect(index);
          onToggle(row);
        }}
      >
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} className={styles.chevron} />
        <Icon name={expanded ? 'folderOpen' : 'folder'} className={styles.folder} />
        <span className={styles.name}>{group.name}</span>
        <span className={styles.count}>{count}</span>
      </div>
    </ContextMenu>
  );
});
