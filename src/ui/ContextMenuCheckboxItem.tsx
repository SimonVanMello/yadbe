import { ContextMenu } from 'radix-ui';
import type { ReactNode } from 'react';

import { Icon } from './Icon';
import styles from './Menu.module.css';

interface ContextMenuCheckboxItemProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}

/** On/off setting inside a `ContextMenu`; the menu stays open so it can be changed and used. */
export function ContextMenuCheckboxItem({
  checked,
  onCheckedChange,
  children,
}: ContextMenuCheckboxItemProps) {
  return (
    <ContextMenu.CheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      className={styles.item}
      onSelect={(event) => {
        event.preventDefault();
      }}
    >
      <span className={styles.iconSpacer}>
        <ContextMenu.ItemIndicator>
          <Icon name="check" />
        </ContextMenu.ItemIndicator>
      </span>
      <span className={styles.itemText}>{children}</span>
    </ContextMenu.CheckboxItem>
  );
}
