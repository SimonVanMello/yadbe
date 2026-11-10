import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';

import { Icon, type IconName } from './Icon';
import { Kbd } from './Kbd';
import styles from './Menu.module.css';

interface MenuItemProps {
  children: ReactNode;
  onSelect?: () => void;
  icon?: IconName;
  /** Secondary line, e.g. the equivalent SQL. */
  hint?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
}

export function MenuItem({
  children,
  onSelect,
  icon,
  hint,
  shortcut,
  danger,
  disabled,
}: MenuItemProps) {
  return (
    <DropdownMenu.Item
      className={[styles.item, danger ? styles.danger : ''].filter(Boolean).join(' ')}
      onSelect={onSelect}
      disabled={disabled}
    >
      {icon && <Icon name={icon} />}
      <span className={styles.itemText}>
        <span>{children}</span>
        {hint && <span className={styles.hint}>{hint}</span>}
      </span>
      {shortcut && <Kbd shortcut={shortcut} className={styles.shortcut} />}
    </DropdownMenu.Item>
  );
}
