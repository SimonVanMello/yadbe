import type { InputHTMLAttributes, Ref } from 'react';

import styles from './TextInput.module.css';

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Monospace, for paths, URLs and identifiers. */
  mono?: boolean;
  invalid?: boolean;
  ref?: Ref<HTMLInputElement>;
}

export function TextInput({ mono, invalid, className, type = 'text', ...rest }: TextInputProps) {
  const classes = [styles.input, mono ? styles.mono : '', className].filter(Boolean).join(' ');
  return (
    <input
      type={type}
      className={classes}
      aria-invalid={invalid || undefined}
      spellCheck={false}
      autoComplete="off"
      {...rest}
    />
  );
}
