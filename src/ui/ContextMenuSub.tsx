import { ContextMenu } from 'radix-ui';
import type { ReactNode } from 'react';

import { Icon, type IconName } from './Icon';
import styles from './Menu.module.css';

/** Submenu of a context menu; opens with → or Enter, closes with ←. */
export function ContextMenuSub({
  label,
  icon,
  disabled,
  children,
}: {
  label: ReactNode;
  icon?: IconName;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className={styles.item} disabled={disabled}>
        {icon ? <Icon name={icon} /> : <span className={styles.iconSpacer} />}
        <span className={styles.itemText}>{label}</span>
        <Icon name="chevronRight" className={styles.shortcut} />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent className={styles.content} sideOffset={4}>
          {children}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
