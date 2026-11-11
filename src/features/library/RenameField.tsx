import { useEffect, useRef, type KeyboardEvent } from 'react';

import styles from './RenameField.module.css';

interface RenameFieldProps {
  value: string;
  label: string;
  /** Enter or leaving the field: the new name (possibly unchanged). */
  onCommit: (name: string) => void;
  /** Esc. */
  onCancel: () => void;
}

/** The name of a row, edited in place: Enter keeps it, Esc leaves it as it was. */
export function RenameField({ value, label, onCommit, onCancel }: RenameFieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  // Enter and Esc leave the field, which then blurs: only the first word counts.
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(ref.current?.value ?? value);
    else onCancel();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // The tree handles letters and arrows as navigation: not while typing a name.
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  };

  return (
    <input
      ref={ref}
      type="text"
      className={styles.field}
      defaultValue={value}
      aria-label={label}
      spellCheck={false}
      autoComplete="off"
      onKeyDown={onKeyDown}
      onClick={(event) => {
        event.stopPropagation();
      }}
      onBlur={() => {
        finish(true);
      }}
    />
  );
}
