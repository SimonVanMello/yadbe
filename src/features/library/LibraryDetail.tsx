import { useI18nStore } from '../../i18n/i18n';
import { formatRelativeTime } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import type { SavedQuery } from '../../ipc';
import { IconButton } from '../../ui/IconButton';
import { Spinner } from '../../ui/Spinner';
import { useNow } from '../../ui/useNow';
import { useConnection } from '../connections/connectionStore';
import { MatchText } from '../history/MatchText';
import styles from './LibraryDetail.module.css';
import {
  copySaved,
  deleteSaved,
  duplicateSaved,
  insertSaved,
  openSaved,
  runSaved,
} from './libraryActions';
import { useSaveDialog } from './saveDialogStore';
import { useSavedQuery } from './useLibrary';

interface LibraryDetailProps {
  /** The row as the list has it (its statement may be cut): shown until the whole one arrives. */
  query: SavedQuery;
  /** The words of the filter, emphasized in the statement and the description. */
  search: string;
}

/** The whole statement of the selected query, its description and what can be done with it. */
export function LibraryDetail({ query: listed, search }: LibraryDetailProps) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const now = useNow();
  const connection = useConnection(listed.connectionId);
  const whole = useSavedQuery(listed.sqlTruncated ? listed.id : null);
  const query = whole.data ?? listed;
  const scope =
    connection === undefined
      ? listed.connectionId === null
        ? t('library.detail.scope.global')
        : t('library.unknownConnection')
      : query.database
        ? t('library.detail.scope.database', {
            connection: connection.name,
            database: query.database,
          })
        : connection.name;

  return (
    <aside className={styles.detail} aria-label={t('library.detail')}>
      <h3 className={styles.name}>{query.name}</h3>
      <div className={styles.header}>
        <p className={styles.facts}>
          {scope}
          {' · '}
          {query.lastUsedAt === null
            ? t('library.detail.never')
            : t('library.detail.lastUsed', {
                when: formatRelativeTime(query.lastUsedAt, now, locale),
              })}
        </p>
        <div className={styles.actions}>
          <IconButton
            icon="plus"
            size="sm"
            label={t('library.menu.open')}
            onClick={() => {
              void openSaved(query);
            }}
          />
          <IconButton
            icon="terminal"
            size="sm"
            label={t('library.menu.insert')}
            onClick={() => {
              void insertSaved(query);
            }}
          />
          <IconButton
            icon="play"
            size="sm"
            label={t('library.menu.run')}
            onClick={() => {
              void runSaved(query);
            }}
          />
          <IconButton
            icon="pencil"
            size="sm"
            label={t('library.menu.edit')}
            onClick={() => {
              useSaveDialog.getState().open({ mode: 'edit', queryId: query.id });
            }}
          />
          <IconButton
            icon="copy"
            size="sm"
            label={t('library.menu.copy')}
            onClick={() => {
              void copySaved(query);
            }}
          />
          <IconButton
            icon="layers"
            size="sm"
            label={t('library.menu.duplicate')}
            onClick={() => {
              void duplicateSaved(query);
            }}
          />
          <IconButton
            icon="trash"
            size="sm"
            label={t('library.menu.delete')}
            onClick={() => {
              void deleteSaved(query);
            }}
          />
        </div>
      </div>
      {query.description !== '' && (
        <p className={styles.description}>
          <MatchText text={query.description} search={search} />
        </p>
      )}
      {(query.tags.length > 0 || query.snippetTrigger !== null) && (
        <div className={styles.tags}>
          {query.snippetTrigger !== null && (
            <span className={styles.snippet}>
              {t('library.detail.snippet', { trigger: query.snippetTrigger })}
            </span>
          )}
          {query.tags.map((tag) => (
            <span key={tag} className={styles.tag}>
              <MatchText text={tag} search={search} />
            </span>
          ))}
        </div>
      )}
      {whole.isPending && listed.sqlTruncated ? (
        <div className={styles.loading}>
          <Spinner />
        </div>
      ) : (
        <pre className={styles.sql}>
          <MatchText text={query.sql} search={search} />
        </pre>
      )}
      {whole.isError && <p className={styles.note}>{t('library.detail.loadFailed')}</p>}
    </aside>
  );
}
