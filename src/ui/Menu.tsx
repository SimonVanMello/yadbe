import { DropdownMenu } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';

import styles from './Menu.module.css';

interface MenuProps {
  /** The element that opens the menu; must accept a ref (a DOM element or a `ui/` primitive). */
  trigger: ReactElement;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Dropdown menu. Compose with `MenuItem`, `MenuLabel` and `MenuSeparator`. */
export function Menu({ trigger, children, align = 'start', open, onOpenChange }: MenuProps) {
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={styles.content} align={align} sideOffset={4}>
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
