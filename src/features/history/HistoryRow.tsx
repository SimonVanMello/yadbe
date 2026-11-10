import type { Ref } from 'react';

import { formatDuration, formatRelativeTime } from '../../i18n/relativeTime';
import type { Locale } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { ConnectionSummary } from '../connections/model';
import { ConnectionTag } from './ConnectionTag';
import styles from './HistoryRow.module.css';
import { MatchText } from './MatchText';
import { OutcomeIcon } from './OutcomeIcon';
import { previewOf, type HistoryEntry } from './historyModel';

/** Characters of a statement rendered in a row: the rest is out of sight anyway. */
const PREVIEW_CHARS = 240;
/** Recent statements read "5 minutes ago"; older ones show their time of day. */
const RELATIVE_FOR_MS = 12 * 3_600_000;

interface HistoryRowProps {
  entry: HistoryEntry;
  connection: ConnectionSummary | undefined;
  selected: boolean;
  /** The search words to emphasize. */
  search: string;
  now: number;
  locale: Locale;
  /** Position given by the virtualizer. */
  index: number;
  offset: number;
  measureRef: Ref<HTMLDivElement>;
  domId: string;
  onSelect: () => void;
  onOpen: () => void;
}

export function formatWhen(startedAt: number, now: number, locale: Locale): string {
  if (now - startedAt < RELATIVE_FOR_MS) return formatRelativeTime(startedAt / 1000, now, locale);
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(startedAt),
  );
}

/** One statement of the history: preview, connection, when, how long, how many rows, outcome. */
export function HistoryRow({
  entry,
  connection,
  selected,
  search,
  now,
  locale,
  index,
  offset,
  measureRef,
  domId,
  onSelect,
  onOpen,
}: HistoryRowProps) {
  const t = useT();
  return (
    <div
      ref={measureRef}
      id={domId}
      role="option"
      aria-selected={selected}
      data-index={index}
      data-outcome={entry.outcome}
      className={styles.row}
      style={{ transform: `translateY(${String(offset)}px)` }}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      <OutcomeIcon outcome={entry.outcome} />
      <div className={styles.body}>
        <code className={styles.sql}>
          <MatchText text={previewOf(entry.sql, PREVIEW_CHARS)} search={search} />
        </code>
        <div className={styles.meta}>
          <ConnectionTag connection={connection} name={entry.connectionName} />
          <span
            className={styles.fact}
            title={new Intl.DateTimeFormat(locale, {
              dateStyle: 'medium',
              timeStyle: 'medium',
            }).format(new Date(entry.startedAt))}
          >
            {formatWhen(entry.startedAt, now, locale)}
          </span>
          {entry.outcome !== 'refused' && (
            <span className={styles.fact}>{formatDuration(entry.durationMs, locale)}</span>
          )}
          {entry.rows !== null && (
            <span className={styles.fact}>{t('history.rows', { count: entry.rows })}</span>
          )}
        </div>
      </div>
    </div>
  );
}
