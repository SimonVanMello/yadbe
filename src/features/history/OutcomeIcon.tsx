import { useT } from '../../i18n/useT';
import type { HistoryOutcome } from '../../ipc';
import { Icon, type IconName } from '../../ui/Icon';
import styles from './OutcomeIcon.module.css';

const ICONS: Record<HistoryOutcome, IconName> = {
  ok: 'check',
  error: 'error',
  cancelled: 'stop',
  refused: 'lock',
};

/** How a statement ended, as an icon in the outcome's color (with its name as a tooltip). */
export function OutcomeIcon({ outcome }: { outcome: HistoryOutcome }) {
  const t = useT();
  const label = t(`history.outcome.${outcome}`);
  return (
    <span
      className={styles.icon}
      data-outcome={outcome}
      role="img"
      aria-label={label}
      title={label}
    >
      <Icon name={ICONS[outcome]} />
    </span>
  );
}
