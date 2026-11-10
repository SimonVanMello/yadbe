import { ContextMenu } from 'radix-ui';
import type { ReactNode } from 'react';

import { Icon, type IconName } from './Icon';
import { Kbd } from './Kbd';
import styles from './Menu.module.css';

interface ContextMenuItemProps {
  children: ReactNode;
  onSelect?: () => void;
  icon?: IconName;
  /** Secondary line, e.g. the equivalent SQL. */
  hint?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
}

export function ContextMenuItem({
  children,
  onSelect,
  icon,
  hint,
  shortcut,
  danger,
  disabled,
}: ContextMenuItemProps) {
  return (
    <ContextMenu.Item
      className={[styles.item, danger ? styles.danger : ''].filter(Boolean).join(' ')}
      onSelect={onSelect}
      disabled={disabled}
    >
      {icon ? <Icon name={icon} /> : <span className={styles.iconSpacer} />}
      <span className={styles.itemText}>
        <span>{children}</span>
        {hint && <span className={styles.hint}>{hint}</span>}
      </span>
      {shortcut && <Kbd shortcut={shortcut} className={styles.shortcut} />}
    </ContextMenu.Item>
  );
}
