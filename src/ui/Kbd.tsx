import { formatShortcut } from './platform';
import styles from './Kbd.module.css';

interface KbdProps {
  /** Shortcut such as `Mod+K`; `Mod` renders as ⌘ on macOS and Ctrl elsewhere. */
  shortcut: string;
  className?: string;
}

export function Kbd({ shortcut, className }: KbdProps) {
  const keys = formatShortcut(shortcut);
  return (
    <span className={[styles.shortcut, className].filter(Boolean).join(' ')}>
      {keys.map((key, index) => (
        <kbd key={`${key}-${index}`} className={styles.kbd}>
          {key}
        </kbd>
      ))}
    </span>
  );
}
