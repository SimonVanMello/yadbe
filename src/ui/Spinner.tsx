import styles from './Spinner.module.css';

/** Indeterminate activity indicator; decorative, pair it with a text label. */
export function Spinner({ className }: { className?: string }) {
  return (
    <span className={[styles.spinner, className].filter(Boolean).join(' ')} aria-hidden="true" />
  );
}
