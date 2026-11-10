import type { CSSProperties, KeyboardEvent } from 'react';

import { useShellStore } from '../../app/shellStore';
import { useT } from '../../i18n/useT';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { Icon } from '../../ui/Icon';
import { useGroupDialog } from '../connections/groupDialogStore';
import { deleteGroup, setGroupCollapsed } from '../connections/groupActions';
import type { ConnectionGroup } from '../connections/model';
import styles from './GroupRow.module.css';

interface GroupRowProps {
  group: ConnectionGroup;
  expanded: boolean;
  count: number;
  depth: number;
  focused: boolean;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

/** A folder of the connection list (F-007): click to fold, right click to rename or delete. */
export function GroupRow({
  group,
  expanded,
  count,
  depth,
  focused,
  onFocus,
  onKeyDown,
}: GroupRowProps) {
  const t = useT();
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
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={expanded}
        aria-selected={false}
        tabIndex={focused ? 0 : -1}
        data-row-id={`group:${group.id}`}
        className={styles.row}
        style={{ '--depth': depth } as CSSProperties}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onClick={() => {
          void setGroupCollapsed(group, expanded);
        }}
      >
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} className={styles.chevron} />
        <Icon name={expanded ? 'folderOpen' : 'folder'} className={styles.folder} />
        <span className={styles.name}>{group.name}</span>
        <span className={styles.count}>{count}</span>
      </div>
    </ContextMenu>
  );
}
