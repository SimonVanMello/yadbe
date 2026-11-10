import type { ReactNode } from 'react';

import styles from './DemoSection.module.css';

export function DemoSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-label={title}>
      <h2 className={styles.heading}>{title}</h2>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
