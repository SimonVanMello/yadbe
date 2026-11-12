import { useI18nStore } from '../../i18n/i18n';
import { formatDuration } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import type { JournalEntry } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { useConnection, useTableQualifier } from '../connections/connectionStore';
import { ConnectionTag } from '../history/ConnectionTag';
import { openDocRevert } from '../document/docEditActions';
import { openKvRevert } from '../keyvalue/kvEditActions';
import { revertChangeSet } from '../table-data/tableActions';
import styles from './JournalDetail.module.css';
import {
  blockerMessage,
  countParts,
  entryTarget,
  revertState,
  statementText,
} from './journalModel';
import { useJournalUi } from './journalStore';
import { useJournalDetail } from './useJournal';

/**
 * The selected change set (F-090): what ran, the inverse statements, and "Revert this change
 * set", or why it cannot be reverted faithfully.
 */
export function JournalDetail({ entry }: { entry: JournalEntry }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const connection = useConnection(entry.connectionId);
  const qualifier = useTableQualifier(entry.engine);
  const detail = useJournalDetail(entry.id);
  const state = revertState(entry);
  const blocker = state.kind === 'blocked' ? blockerMessage(state.blocker) : null;

  return (
    <aside className={styles.detail} aria-label={t('journal.detail')}>
      <div className={styles.identity}>
        <ConnectionTag connection={connection} name={entry.connectionName} />
        <code className={styles.table}>{entryTarget(entry, qualifier)}</code>
      </div>
      <p className={styles.facts}>
        {t('journal.entryId', { id: entry.id })} ·{' '}
        {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(entry.appliedAt ?? 0),
        )}
        {` · ${formatDuration(entry.durationMs ?? 0, locale)} · `}
        {countParts(entry)
          .map((part) => t(part.key, { count: part.count }))
          .join(', ')}
      </p>
      {entry.reverts !== null && (
        <button
          type="button"
          className={styles.link}
          onClick={() => {
            useJournalUi.getState().select(entry.reverts);
          }}
        >
          {t('journal.revertOf', { id: entry.reverts })}
        </button>
      )}
      {state.kind === 'reverted' && (
        <p className={styles.note}>
          <Icon name="undo" />
          <span>
            {t('journal.revertedBy', { id: state.by })}{' '}
            <button
              type="button"
              className={styles.link}
              onClick={() => {
                useJournalUi.getState().select(state.by);
              }}
            >
              {t('journal.show')}
            </button>
          </span>
        </p>
      )}
      {blocker && (
        <p className={styles.blocked} role="note">
          <Icon name="warning" />
          <span>
            <strong>{t('journal.notRevertible')}</strong> {t(blocker.key, blocker.params)}
          </span>
        </p>
      )}
      {state.kind === 'revertible' && (
        <div className={styles.actions}>
          <Button
            size="sm"
            disabled={connection === undefined}
            title={connection === undefined ? t('journal.connectionDeleted') : undefined}
            onClick={() => {
              if (entry.family === 'keyValue') void openKvRevert(entry.connectionId, entry.id);
              else if (entry.family === 'document')
                void openDocRevert(
                  entry.connectionId,
                  entry.id,
                  `${entry.table.database}.${entry.table.name}`,
                );
              else void revertChangeSet(entry.connectionId, entry.table, entry.id);
            }}
          >
            <Icon name="undo" />
            {t('journal.revert')}
          </Button>
        </div>
      )}
      {detail.isPending && (
        <div className={styles.loading}>
          <Spinner />
        </div>
      )}
      {detail.data && (
        <>
          <h3 className={styles.heading}>{t('journal.statements')}</h3>
          <pre className={styles.sql} data-testid="journal-statements">
            {detail.data.statements.map((s) => statementText(entry, s.sql)).join('\n')}
          </pre>
          {detail.data.inverseStatements.length > 0 && (
            <>
              <h3 className={styles.heading}>{t('journal.inverse')}</h3>
              <pre className={styles.sql} data-testid="journal-inverse">
                {detail.data.inverseStatements.map((sql) => statementText(entry, sql)).join('\n')}
              </pre>
            </>
          )}
        </>
      )}
    </aside>
  );
}
