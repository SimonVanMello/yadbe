import type { ReactNode } from 'react';

import styles from './Field.module.css';

interface FieldProps {
  label: ReactNode;
  /** `id` of the control, so the label is clickable. */
  htmlFor?: string;
  hint?: ReactNode;
  /** What is wrong with the value; replaces the hint, in the danger color. */
  error?: ReactNode;
  children: ReactNode;
}

/** A labelled form control with an optional hint (or error) under it. */
export function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <div className={`${styles.hint} ${styles.error}`} role="alert">
          {error}
        </div>
      ) : (
        hint && <div className={styles.hint}>{hint}</div>
      )}
    </div>
  );
}
