import { useI18nStore } from '../../i18n/i18n';
import { formatDuration } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Spinner } from '../../ui/Spinner';
import { useConnection } from '../connections/connectionStore';
import { ConnectionTag } from './ConnectionTag';
import styles from './HistoryDetail.module.css';
import { MatchText } from './MatchText';
import { OutcomeIcon } from './OutcomeIcon';
import { copyEntry, deleteEntry, insertEntry, openEntry } from './historyActions';
import type { HistoryEntry } from './historyModel';
import { useHistoryEntry } from './useHistory';

interface HistoryDetailProps {
  /** The row as the list has it (its statement may be cut): shown until the whole one arrives. */
  entry: HistoryEntry;
  search: string;
}

/** The whole statement of the selected entry, its error and what can be done with it. */
export function HistoryDetail({ entry: listed, search }: HistoryDetailProps) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const connection = useConnection(listed.connectionId);
  const whole = useHistoryEntry(listed.sqlTruncated ? listed.id : null);
  const entry = whole.data ?? listed;

  return (
    <aside className={styles.detail} aria-label={t('history.detail')}>
      <div className={styles.identity}>
        <OutcomeIcon outcome={entry.outcome} />
        <ConnectionTag connection={connection} name={entry.connectionName} />
        {entry.database !== null && <span className={styles.database}>{entry.database}</span>}
      </div>
      <div className={styles.header}>
        <p className={styles.facts}>
          {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
            new Date(entry.startedAt),
          )}
          {entry.outcome !== 'refused' && ` · ${formatDuration(entry.durationMs, locale)}`}
          {entry.outcome === 'ok' &&
            entry.rows !== null &&
            ` · ${t('history.rows', { count: entry.rows })}`}
        </p>
        <div className={styles.actions}>
          <IconButton
            icon="plus"
            size="sm"
            label={t('history.action.open')}
            disabled={connection === undefined}
            onClick={() => {
              void openEntry(entry);
            }}
          />
          <IconButton
            icon="terminal"
            size="sm"
            label={t('history.action.insert')}
            onClick={() => {
              void insertEntry(entry);
            }}
          />
          <IconButton
            icon="copy"
            size="sm"
            label={t('history.action.copy')}
            onClick={() => {
              void copyEntry(entry);
            }}
          />
          <IconButton
            icon="trash"
            size="sm"
            label={t('history.action.delete')}
            onClick={() => {
              void deleteEntry(entry);
            }}
          />
        </div>
      </div>
      {whole.isPending && listed.sqlTruncated ? (
        <div className={styles.loading}>
          <Spinner />
        </div>
      ) : (
        <pre className={styles.sql}>
          <MatchText text={entry.sql} search={search} />
        </pre>
      )}
      {whole.isError && <p className={styles.note}>{t('history.detail.loadFailed')}</p>}
      {entry.errorMessage !== null && (
        <div
          className={styles.error}
          data-outcome={entry.outcome}
          role="alert"
          aria-label={t('history.detail.error')}
        >
          <Icon name={entry.outcome === 'error' ? 'error' : 'warning'} />
          <p>{entry.errorMessage}</p>
        </div>
      )}
    </aside>
  );
}
