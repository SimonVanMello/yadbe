import { useT } from '../../i18n/useT';
import { useConnection, useTableQualifier } from '../connections/connectionStore';
import type { ResultReadOnlyReason } from '../../ipc';
import { Icon } from '../../ui/Icon';
import { useTabTransaction } from '../query/executionStore';
import { readOnlyReasons } from './resultEditModel';
import styles from './ResultEdit.module.css';
import { editTableLabel, type ResultEditEntry } from './resultEdits';

/**
 * Whether a result can be edited, in its footer (F-087): "Editable · table", or "Read-only"
 * with the reason (the first one; all of them on hover). `sorted`: an editable result shown
 * sorted or filtered (F-065), with the pending changes that wait for the view to be gone.
 */
export function ResultEditStatus({
  entry,
  sorted = null,
}: {
  entry: ResultEditEntry | undefined;
  sorted?: { pending: number } | null;
}) {
  const t = useT();
  const transaction = useTabTransaction(entry?.tabId ?? '');
  const qualifier = useTableQualifier(useConnection(entry?.connectionId ?? null)?.engine ?? null);
  if (!entry || entry.status === 'loading') return null;
  if (entry.status === 'failed') {
    return (
      <span className={styles.readOnly} data-testid="result-edit-status" data-editable="false">
        <Icon name="lock" />
        <span className={styles.reason}>{t('resultEdit.describeFailed')}</span>
      </span>
    );
  }
  const reasons = readOnlyReasons(entry.info, transaction);
  const columns = entry.info?.rowIdentity.join(', ') ?? '';
  const text = (reason: ResultReadOnlyReason) => t(`resultEdit.readOnly.${reason}`, { columns });
  const texts = reasons.map(text);
  if (sorted && reasons.length === 0) {
    // Changes that wait come first: they are what the user must not forget.
    if (sorted.pending > 0) texts.push(t('resultEdit.pendingHidden', { count: sorted.pending }));
    texts.push(t('resultEdit.readOnly.sorted'));
  }
  if (texts.length > 0) {
    const all = texts.join(' ');
    return (
      <span
        className={styles.readOnly}
        title={all}
        data-testid="result-edit-status"
        data-editable="false"
      >
        <Icon name="lock" />
        <strong>{t('resultEdit.readOnly')}</strong>
        <span className={styles.reason}>{texts[0] ?? ''}</span>
      </span>
    );
  }
  const table = editTableLabel(entry, qualifier);
  return (
    <span
      className={styles.editable}
      title={t('resultEdit.editableHint', { table })}
      data-testid="result-edit-status"
      data-editable="true"
    >
      <Icon name="pencil" />
      <strong>{t('resultEdit.editable')}</strong>
      <span className={styles.table}>{table}</span>
    </span>
  );
}
