import { Dialog as RadixDialog } from 'radix-ui';
import type { ReactNode } from 'react';

import styles from './Dialog.module.css';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Action buttons, rendered right-aligned. */
  footer?: ReactNode;
  /** Outcome of what the dialog does, between the content and the buttons: never scrolled away. */
  notice?: ReactNode;
  /** Wider dialog with its own scrolling, for settings screens. */
  wide?: boolean;
  /** Call `preventDefault()` to keep the dialog open on `Esc` (a field that uses the key). */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
}

/** Modal dialog. Focus is trapped inside and restored on close; `Esc` closes it. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  notice,
  wide,
  onEscapeKeyDown,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          className={wide ? `${styles.content} ${styles.wide}` : styles.content}
          data-modal=""
          onEscapeKeyDown={onEscapeKeyDown}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className={styles.header}>
            <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
            {description && (
              <RadixDialog.Description className={styles.description}>
                {description}
              </RadixDialog.Description>
            )}
          </div>
          {children && <div className={styles.body}>{children}</div>}
          {notice && <div className={styles.notice}>{notice}</div>}
          {footer && <div className={styles.footer}>{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
