import type { Ref, TextareaHTMLAttributes } from 'react';

import styles from './TextArea.module.css';

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Monospace, for SQL. */
  mono?: boolean;
  invalid?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

/** Multi-line text field, styled like `TextInput`. */
export function TextArea({ mono, invalid, className, rows = 3, ...rest }: TextAreaProps) {
  const classes = [styles.area, mono ? styles.mono : '', className].filter(Boolean).join(' ');
  return (
    <textarea
      className={classes}
      rows={rows}
      aria-invalid={invalid || undefined}
      spellCheck={false}
      {...rest}
    />
  );
}
