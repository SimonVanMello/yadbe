import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Tooltip } from '../../ui/Tooltip';
import { discardPending, newDocument, openSearchApply, unstageDoc } from './searchEditActions';
import { blockText, describe } from './searchEditModel';
import { useSearchEditTab } from './searchEditStore';
import styles from './SearchEdit.module.css';

/**
 * The edit strip of an index tab (M4-8): add a document, the documents staged (each can be
 * dropped), review and apply them, or why nothing can be changed here.
 */
export function PendingDocsBar({ tabId }: { tabId: string }) {
  const t = useT();
  const { info, pending } = useSearchEditTab(tabId);
  if (!info) return null;
  const readOnly = info.readOnly ? blockText({ kind: 'readOnlyConnection' }) : null;
  const canCreate = info.createTargets.length > 0;
  return (
    <div className={styles.bar} role="toolbar" aria-label={t('search.edit.bar')}>
      <Tooltip
        content={
          readOnly
            ? t(readOnly.key, readOnly.params)
            : canCreate
              ? t('search.edit.add.hint')
              : t('search.edit.add.none')
        }
      >
        <span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!canCreate}
            onClick={() => {
              newDocument(tabId);
            }}
          >
            <Icon name="plus" />
            {t('search.edit.add')}
          </Button>
        </span>
      </Tooltip>
      {readOnly && (
        <span className={styles.readOnly} data-testid="search-read-only">
          <Icon name="lock" />
          {t(readOnly.key, readOnly.params)}
        </span>
      )}
      {!readOnly && info.dataStreams.length > 0 && (
        <span className={styles.readOnly} data-testid="search-data-stream">
          <Icon name="info" />
          {t('search.edit.dataStreamNote')}
        </span>
      )}
      {pending.length > 0 && (
        <>
          <span className={styles.pending} data-testid="search-pending">
            {t('search.edit.pending', { count: pending.length })}
          </span>
          <span className={styles.chips}>
            {pending.map((doc) => {
              const said = describe(doc.edit);
              return (
                <span key={doc.key} className={styles.chip} data-kind={doc.edit.kind}>
                  <span className={styles.chipText}>{t(said.key, said.params)}</span>
                  <IconButton
                    icon="close"
                    size="sm"
                    label={t('search.edit.unstage')}
                    onClick={() => {
                      unstageDoc(tabId, doc.key);
                    }}
                  />
                </span>
              );
            })}
          </span>
        </>
      )}
      <span className={styles.spacer} />
      {pending.length > 0 && (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              discardPending(tabId);
            }}
          >
            {t('search.edit.discard')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              void openSearchApply(tabId);
            }}
          >
            <Icon name="check" />
            {t('search.edit.review', { count: pending.length })}
          </Button>
        </>
      )}
    </div>
  );
}
