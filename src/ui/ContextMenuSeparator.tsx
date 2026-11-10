import { ContextMenu } from 'radix-ui';

import styles from './Menu.module.css';

export function ContextMenuSeparator() {
  return <ContextMenu.Separator className={styles.separator} />;
}
