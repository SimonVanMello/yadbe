import { memo, type CSSProperties } from 'react';

import { useT } from '../../i18n/useT';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { Icon } from '../../ui/Icon';
import { Highlight } from '../connections/Highlight';
import { rowStyle } from '../sidebar/rowStyle';
import { copyBuiltin, insertBuiltin } from './libraryActions';
import type { BuiltinTreeRow } from './libraryModel';
import type { LibraryRowCommon } from './libraryRowProps';
import styles from './QueryRow.module.css';

interface BuiltinRowProps extends LibraryRowCommon {
  row: BuiltinTreeRow;
}

/** A built-in snippet: read-only, inserted or copied into the library to be customized. */
export const BuiltinRow = memo(function BuiltinRow({
  row,
  id,
  index,
  active,
  posInSet,
  setSize,
  offset,
  height,
  onSelect,
}: BuiltinRowProps) {
  const t = useT();
  const { snippet } = row;
  return (
    <ContextMenu
      content={
        <>
          <ContextMenuItem
            icon="terminal"
            shortcut="Mod+Enter"
            onSelect={() => {
              insertBuiltin(snippet);
            }}
          >
            {t('library.menu.insert')}
          </ContextMenuItem>
          <ContextMenuItem
            icon="copy"
            onSelect={() => {
              copyBuiltin(snippet);
            }}
          >
            {t('library.builtin.copy')}
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
        aria-selected={active}
        data-row-index={index}
        data-active={active || undefined}
        data-builtin=""
        className={styles.row}
        style={{ ...rowStyle(offset, height), '--depth': 1 } as CSSProperties}
        onClick={() => {
          onSelect(index);
        }}
        onDoubleClick={() => {
          insertBuiltin(snippet);
        }}
      >
        <Icon name="bolt" className={styles.icon} />
        <span className={styles.name}>
          <Highlight text={row.name} indices={row.indices} />
        </span>
        <code className={styles.trigger}>{snippet.trigger}</code>
      </div>
    </ContextMenu>
  );
});
