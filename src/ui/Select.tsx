import type { Ref, SelectHTMLAttributes } from 'react';

import { Icon } from './Icon';
import styles from './Select.module.css';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

interface SelectProps<T extends string> extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'value' | 'onChange' | 'children'
> {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  ref?: Ref<HTMLSelectElement>;
}

/** Single-choice dropdown. A native `<select>`: keyboard, screen reader and OS popup for free. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  className,
  ...rest
}: SelectProps<T>) {
  return (
    <span className={[styles.wrapper, className].filter(Boolean).join(' ')}>
      <select
        className={styles.select}
        value={value}
        onChange={(event) => {
          const option = options.find((candidate) => candidate.value === event.target.value);
          if (option) onChange(option.value);
        }}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" className={styles.chevron} />
    </span>
  );
}
