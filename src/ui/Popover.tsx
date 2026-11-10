import { Popover as RadixPopover } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';

import styles from './Popover.module.css';

interface PopoverProps {
  /** The element that toggles the popover; must accept a ref and forward props. */
  trigger: ReactElement;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Floating panel anchored to its trigger, for small forms (unlike `Menu`, it holds controls). */
export function Popover({
  trigger,
  children,
  side = 'bottom',
  align = 'end',
  open,
  onOpenChange,
}: PopoverProps) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content className={styles.content} side={side} align={align} sideOffset={6}>
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
