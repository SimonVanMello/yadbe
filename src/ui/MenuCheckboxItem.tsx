import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';

import { Icon } from './Icon';
import styles from './Menu.module.css';

interface MenuCheckboxItemProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
  /** Secondary line, e.g. the equivalent SQL. */
  hint?: ReactNode;
}

/** On/off setting inside a `Menu`; the menu stays open to change several in a row. */
export function MenuCheckboxItem({
  checked,
  onCheckedChange,
  children,
  hint,
}: MenuCheckboxItemProps) {
  return (
    <DropdownMenu.CheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      className={styles.item}
      onSelect={(event) => {
        event.preventDefault();
      }}
    >
      <span className={styles.iconSpacer}>
        <DropdownMenu.ItemIndicator>
          <Icon name="check" />
        </DropdownMenu.ItemIndicator>
      </span>
      <span className={styles.itemText}>
        <span>{children}</span>
        {hint && <span className={styles.hint}>{hint}</span>}
      </span>
    </DropdownMenu.CheckboxItem>
  );
}
