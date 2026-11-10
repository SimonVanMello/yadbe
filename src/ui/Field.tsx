import type { ReactNode } from 'react';

import styles from './Field.module.css';

interface FieldProps {
  label: ReactNode;
  /** `id` of the control, so the label is clickable. */
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}

/** A labelled form control with an optional hint under it. */
export function Field({ label, htmlFor, hint, children }: FieldProps) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <div className={styles.hint}>{hint}</div>}
    </div>
  );
}
