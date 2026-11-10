import { ContextMenu as RadixContextMenu } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';

import styles from './Menu.module.css';

interface ContextMenuProps {
  /** The element that opens the menu on right click; must accept a ref. */
  children: ReactElement;
  content: ReactNode;
  onOpenChange?: (open: boolean) => void;
}

/** Right-click menu. Compose with `ContextMenuItem` and `ContextMenuSeparator`. */
export function ContextMenu({ children, content, onOpenChange }: ContextMenuProps) {
  return (
    <RadixContextMenu.Root onOpenChange={onOpenChange}>
      <RadixContextMenu.Trigger asChild>{children}</RadixContextMenu.Trigger>
      <RadixContextMenu.Portal>
        <RadixContextMenu.Content className={styles.content}>{content}</RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  );
}
