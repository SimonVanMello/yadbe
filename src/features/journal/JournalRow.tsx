import type { Ref } from 'react';

import type { Locale } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { JournalEntry } from '../../ipc';
import { Icon } from '../../ui/Icon';
import { useTableQualifier } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import { ConnectionTag } from '../history/ConnectionTag';
import { formatWhen } from '../history/HistoryRow';
import { countParts, revertState, tableText } from './journalModel';
import styles from './JournalRow.module.css';

interface JournalRowProps {
  entry: JournalEntry;
  connection: ConnectionSummary | undefined;
  selected: boolean;
  now: number;
  locale: Locale;
  index: number;
  offset: number;
  measureRef: Ref<HTMLDivElement>;
  domId: string;
  onSelect: () => void;
}

/** One applied change set: its table, what it did, where and when, and whether it can be undone. */
export function JournalRow({
  entry,
  connection,
  selected,
  now,
  locale,
  index,
  offset,
  measureRef,
  domId,
  onSelect,
}: JournalRowProps) {
  const t = useT();
  const qualifier = useTableQualifier(entry.engine);
  const state = revertState(entry);
  return (
    <div
      ref={measureRef}
      id={domId}
      role="option"
      aria-selected={selected}
      data-index={index}
      data-state={state.kind}
      className={styles.row}
      style={{ transform: `translateY(${String(offset)}px)` }}
      onClick={onSelect}
    >
      <Icon name={entry.reverts === null ? 'table' : 'undo'} className={styles.icon} />
      <div className={styles.body}>
        <div className={styles.title}>
          <code className={styles.table}>{tableText(entry.table, qualifier)}</code>
          <span className={styles.counts}>
            {countParts(entry)
              .map((part) => t(part.key, { count: part.count }))
              .join(' · ')}
          </span>
        </div>
        <div className={styles.meta}>
          <ConnectionTag connection={connection} name={entry.connectionName} />
          <span
            className={styles.fact}
            title={new Intl.DateTimeFormat(locale, {
              dateStyle: 'medium',
              timeStyle: 'medium',
            }).format(new Date(entry.appliedAt ?? 0))}
          >
            {formatWhen(entry.appliedAt ?? 0, now, locale)}
          </span>
          {entry.reverts !== null && (
            <span className={styles.badge}>
              {t('journal.badge.revertOf', { id: entry.reverts })}
            </span>
          )}
          {state.kind === 'reverted' && (
            <span className={styles.badge} data-kind="reverted">
              {t('journal.badge.reverted')}
            </span>
          )}
          {state.kind === 'blocked' && (
            <span className={styles.badge} data-kind="blocked">
              {t('journal.badge.notRevertible')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
