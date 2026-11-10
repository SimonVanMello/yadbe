import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';

import { Icon } from './Icon';
import styles from './Menu.module.css';

export function MenuRadioItem({ value, children }: { value: string; children: ReactNode }) {
  return (
    <DropdownMenu.RadioItem
      value={value}
      className={styles.item}
      onSelect={(event) => {
        // Keep the menu open so several settings can be changed in a row.
        event.preventDefault();
      }}
    >
      <span className={styles.iconSpacer}>
        <DropdownMenu.ItemIndicator>
          <Icon name="check" />
        </DropdownMenu.ItemIndicator>
      </span>
      <span className={styles.itemText}>{children}</span>
    </DropdownMenu.RadioItem>
  );
}
