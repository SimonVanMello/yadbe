import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import styles from './KeyEdit.module.css';
import { applyTab, discardEdits, previewTab } from './kvEditActions';
import { pendingCount } from './kvEditModel';
import { useKvEditStore, useTabEdits } from './kvEditStore';

/**
 * The pending changes of a key tab, as in a table tab (F-084, F-085): their count, discard,
 * the commands they will run, Apply. On a read-only connection, why nothing can be changed.
 */
export function KeyEditBar({ tabId, readOnly }: { tabId: string; readOnly: boolean }) {
  const t = useT();
  const edits = useTabEdits(tabId);
  const applying = useKvEditStore(
    (state) =>
      state.dialog?.source.kind === 'tab' &&
      state.dialog.source.tabId === tabId &&
      state.dialog.status === 'applying',
  );
  const count = pendingCount(edits);
  if (readOnly) {
    return (
      <div className={styles.bar} role="note" data-testid="kv-edit-bar">
        <span className={styles.readOnly}>
          <Icon name="lock" size="sm" />
          {t('keyValue.edit.readOnly')}
        </span>
      </div>
    );
  }
  return (
    <div
      className={styles.bar}
      role="toolbar"
      aria-label={t('keyValue.edit.changes')}
      data-testid="kv-edit-bar"
    >
      <span
        className={styles.pending}
        data-pending={count > 0 || undefined}
        role="status"
        data-testid="kv-pending"
      >
        {count > 0 ? t('tableData.pending', { count }) : t('tableData.noPending')}
      </span>
      <span className={styles.spacer} />
      <IconButton
        icon="undo"
        label={t('keyValue.edit.discard')}
        disabled={count === 0 || applying}
        onClick={() => {
          discardEdits(tabId);
        }}
      />
      <Button
        size="sm"
        disabled={count === 0 || applying}
        onClick={() => {
          void previewTab(tabId);
        }}
      >
        <Icon name="eye" />
        {t('keyValue.edit.preview')}
      </Button>
      <Button
        variant="primary"
        size="sm"
        disabled={count === 0 || applying}
        onClick={() => {
          void applyTab(tabId);
        }}
      >
        <Icon name="check" />
        {t('tableData.apply.button')}
      </Button>
    </div>
  );
}
