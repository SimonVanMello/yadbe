import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';

import styles from './Menu.module.css';

interface MenuRadioGroupProps<T extends string> {
  label: string;
  value: T;
  onValueChange: (value: T) => void;
  children: ReactNode;
}

/** Single-choice group inside a `Menu`, e.g. the theme. Compose with `MenuRadioItem`. */
export function MenuRadioGroup<T extends string>({
  label,
  value,
  onValueChange,
  children,
}: MenuRadioGroupProps<T>) {
  return (
    <DropdownMenu.Group>
      <DropdownMenu.Label className={styles.groupLabel}>{label}</DropdownMenu.Label>
      <DropdownMenu.RadioGroup
        value={value}
        onValueChange={(next) => {
          onValueChange(next as T);
        }}
      >
        {children}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Group>
  );
}
