import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';

import styles from './Menu.module.css';

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className={styles.label}>{children}</DropdownMenu.Label>;
}
