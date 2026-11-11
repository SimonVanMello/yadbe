import { useEffect, useRef, useState } from 'react';

import { useT } from '../../i18n/useT';
import type { ExplorerRow } from '../explorer/explorerRows';
import styles from './RenameField.module.css';
import { commitRename, useRenameStore } from './renameStore';

/**
 * The name of an explorer row as a field (F2). Enter asks for the confirmation of the rename,
 * Esc and a click elsewhere leave the name alone. Its keys stay in the field: the tree around it
 * navigates and types ahead with them.
 */
export function RenameField({ row, name }: { row: ExplorerRow; name: string }) {
  const t = useT();
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const leave = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const tree = ref.current?.closest<HTMLElement>('[role="tree"]');
    if (commit) commitRename(row, value);
    else useRenameStore.getState().stop();
    tree?.focus({ preventScroll: true });
  };

  return (
    <input
      ref={ref}
      className={styles.field}
      value={value}
      spellCheck={false}
      autoComplete="off"
      aria-label={t('objects.rename.label', { name })}
      title={t('objects.rename.hint')}
      onChange={(event) => {
        setValue(event.target.value);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          leave(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          leave(false);
        }
      }}
      onBlur={() => {
        leave(false);
      }}
      onClick={(event) => {
        event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
      }}
    />
  );
}
