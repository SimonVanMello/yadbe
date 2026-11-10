import type { ButtonHTMLAttributes, Ref } from 'react';

import { Icon, type IconName } from './Icon';
import styles from './IconButton.module.css';
import { Tooltip } from './Tooltip';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconName;
  /** Accessible name, also shown as the tooltip. */
  label: string;
  /** Optional shortcut shown in the tooltip, e.g. `Mod+Shift+P`. */
  shortcut?: string;
  size?: 'sm' | 'md';
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  icon,
  label,
  shortcut,
  size = 'md',
  type = 'button',
  className,
  ...rest
}: IconButtonProps) {
  const classes = [styles.iconButton, size === 'sm' ? styles.sm : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button type={type} aria-label={label} className={classes} {...rest}>
        <Icon name={icon} size={size === 'sm' ? 'sm' : 'md'} />
      </button>
    </Tooltip>
  );
}
