import type { Locale } from '../../i18n/i18n';
import { formatDuration } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import type { StatementLogEntry } from '../../ipc';
import { Icon } from '../../ui/Icon';
import styles from './LogEntryRow.module.css';
import { isFailed } from './statementLogStore';

interface LogEntryRowProps {
  entry: StatementLogEntry;
  selected: boolean;
  /** Position and height given by the virtualizer. */
  offset: number;
  height: number;
  locale: Locale;
  onSelect: () => void;
}

function formatTime(epochMs: number | null, locale: Locale): string {
  if (epochMs === null) return '—';
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(epochMs));
}

/** One line of the statement log: time, connection, SQL, duration, outcome. */
export function LogEntryRow({
  entry,
  selected,
  offset,
  height,
  locale,
  onSelect,
}: LogEntryRowProps) {
  const t = useT();
  const { outcome } = entry;
  return (
    <div
      role="option"
      aria-selected={selected}
      data-failed={isFailed(entry) || undefined}
      className={styles.row}
      style={{ height, transform: `translateY(${String(offset)}px)` }}
      onClick={onSelect}
    >
      <span className={styles.time}>{formatTime(entry.startedAt, locale)}</span>
      <span className={styles.connection}>{entry.connectionName || '—'}</span>
      <code className={styles.sql}>{entry.sql.replace(/\s+/g, ' ')}</code>
      <span className={styles.duration}>
        {entry.durationMs === null ? '—' : formatDuration(entry.durationMs, locale)}
      </span>
      <span className={styles.outcome}>
        {outcome.kind === 'error' ? (
          <>
            <Icon name="error" />
            {t('log.failed')}
          </>
        ) : outcome.rows !== null ? (
          t('log.rows', { count: outcome.rows })
        ) : (
          <Icon name="check" />
        )}
      </span>
    </div>
  );
}
