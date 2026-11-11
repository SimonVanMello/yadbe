import { memo, type CSSProperties } from 'react';

import { useT } from '../../i18n/useT';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { ContextMenuSeparator } from '../../ui/ContextMenuSeparator';
import { Icon } from '../../ui/Icon';
import { rowStyle } from '../sidebar/rowStyle';
import styles from './FolderRow.module.css';
import { createFolder, deleteFolder, renameFolder } from './libraryActions';
import type { FolderTreeRow } from './libraryModel';
import type { LibraryDrag, LibraryRowCommon } from './libraryRowProps';
import { useLibraryUi } from './libraryStore';
import { RenameField } from './RenameField';

interface FolderRowProps extends LibraryRowCommon {
  row: FolderTreeRow;
  renaming: boolean;
  dropping: boolean;
  drag: LibraryDrag;
  onToggle: (row: FolderTreeRow) => void;
}

/** A folder of the library: click to fold, right click to rename or delete, drop to move into. */
export const FolderRow = memo(function FolderRow({
  row,
  id,
  index,
  active,
  posInSet,
  setSize,
  offset,
  height,
  renaming,
  dropping,
  drag,
  onSelect,
  onToggle,
}: FolderRowProps) {
  const t = useT();
  const { folder, expanded, count } = row;
  const stopRenaming = () => {
    useLibraryUi.getState().startRename(null);
  };
  return (
    <ContextMenu
      content={
        <>
          <ContextMenuItem
            icon="folder"
            onSelect={() => {
              void createFolder(folder.id);
            }}
          >
            {t('library.menu.newSubfolder')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon="pencil"
            shortcut="F2"
            onSelect={() => {
              useLibraryUi.getState().startRename(row.key);
            }}
          >
            {t('library.menu.rename')}
          </ContextMenuItem>
          <ContextMenuItem
            icon="trash"
            danger
            onSelect={() => {
              void deleteFolder(folder);
            }}
          >
            {t('library.menu.delete')}
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
        data-drop={dropping || undefined}
        draggable={!renaming}
        className={styles.row}
        style={{ ...rowStyle(offset, height), '--depth': row.level - 1 } as CSSProperties}
        onClick={() => {
          onSelect(index);
          if (!renaming) onToggle(row);
        }}
        onDragStart={(event) => {
          drag.start(event, row.key);
        }}
        onDragOver={(event) => {
          drag.over(event, row);
        }}
        onDragLeave={() => {
          drag.leave(row);
        }}
        onDrop={(event) => {
          drag.drop(event, row);
        }}
        onDragEnd={drag.end}
      >
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} className={styles.chevron} />
        <Icon name={expanded ? 'folderOpen' : 'folder'} className={styles.folder} />
        {renaming ? (
          <RenameField
            value={folder.name}
            label={t('library.row.name', { name: folder.name })}
            onCommit={(name) => {
              stopRenaming();
              void renameFolder(folder, name);
            }}
            onCancel={stopRenaming}
          />
        ) : (
          <>
            <span className={styles.name}>{folder.name}</span>
            <span className={styles.count}>{count}</span>
          </>
        )}
      </div>
    </ContextMenu>
  );
});
