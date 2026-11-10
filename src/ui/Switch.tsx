import { Switch as RadixSwitch } from 'radix-ui';
import { useId, type ReactNode } from 'react';

import styles from './Switch.module.css';

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  /** Secondary line under the label. */
  hint?: ReactNode;
  disabled?: boolean;
}

/** On/off setting with its label (clicking the label toggles it). */
export function Switch({ checked, onCheckedChange, label, hint, disabled }: SwitchProps) {
  const id = useId();
  return (
    <div className={styles.row}>
      <label htmlFor={id} className={styles.text}>
        <span className={styles.label}>{label}</span>
        {hint && <span className={styles.hint}>{hint}</span>}
      </label>
      <RadixSwitch.Root
        id={id}
        className={styles.root}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      >
        <RadixSwitch.Thumb className={styles.thumb} />
      </RadixSwitch.Root>
    </div>
  );
}
