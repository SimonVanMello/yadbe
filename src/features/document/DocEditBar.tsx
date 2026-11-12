import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { discardDocEdits, newDocument, reviewChanges, type EditBlock } from './docEditActions';
import { pendingCount } from './docEditModel';
import { useTabDocEdits } from './docEditStore';
import styles from './DocEdit.module.css';

/**
 * The edit controls of a collection tab (M4-4): add a document, the pending count, review and
 * apply, discard; or why the documents cannot be changed.
 */
export function DocEditBar({ tabId, block }: { tabId: string; block: EditBlock | null }) {
  const t = useT();
  const edits = useTabDocEdits(tabId);
  const count = pendingCount(edits);
  if (block && count === 0) {
    return (
      <span className={styles.readOnly} data-testid="doc-edit-blocked">
        <Icon name="lock" />
        {t(block)}
      </span>
    );
  }
  return (
    <span className={styles.bar} role="group" aria-label={t('mongo.edit.label')}>
      {!block && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            newDocument(tabId);
          }}
        >
          <Icon name="plus" />
          {t('mongo.edit.add')}
        </Button>
      )}
      <span
        className={styles.pending}
        data-pending={count > 0 || undefined}
        data-testid="doc-pending"
      >
        {count > 0 ? t('mongo.edit.pending', { count }) : t('mongo.edit.none')}
      </span>
      {count > 0 && (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void discardDocEdits(tabId);
            }}
          >
            {t('mongo.edit.discard')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              void reviewChanges(tabId);
            }}
          >
            <Icon name="check" />
            {t('mongo.edit.review')}
          </Button>
        </>
      )}
    </span>
  );
}
