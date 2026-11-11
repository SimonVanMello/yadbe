import { memo, type CSSProperties } from 'react';

import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { rowStyle } from '../sidebar/rowStyle';
import styles from './FolderRow.module.css';
import type { BuiltinHeaderRow as BuiltinHeader } from './libraryModel';
import type { LibraryRowCommon } from './libraryRowProps';

interface BuiltinHeaderRowProps extends LibraryRowCommon {
  row: BuiltinHeader;
  onToggle: () => void;
}

/** The heading of the built-in snippets, folded by default. */
export const BuiltinHeaderRow = memo(function BuiltinHeaderRow({
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
}: BuiltinHeaderRowProps) {
  const t = useT();
  return (
    <div
      id={id}
      role="treeitem"
      aria-level={row.level}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-expanded={row.expanded}
      aria-selected={active}
      data-row-index={index}
      data-active={active || undefined}
      data-builtin-header=""
      className={styles.row}
      style={{ ...rowStyle(offset, height), '--depth': 0 } as CSSProperties}
      onClick={() => {
        onSelect(index);
        onToggle();
      }}
    >
      <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} className={styles.chevron} />
      <Icon name="bolt" className={styles.folder} />
      <span className={styles.name}>{t('library.builtin.title')}</span>
      <span className={styles.count}>{row.count}</span>
    </div>
  );
});
