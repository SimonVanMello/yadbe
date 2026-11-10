import { DropdownMenu } from 'radix-ui';

import styles from './Menu.module.css';

export function MenuSeparator() {
  return <DropdownMenu.Separator className={styles.separator} />;
}
