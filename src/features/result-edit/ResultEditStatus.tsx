import { useT } from '../../i18n/useT';
import type { ResultReadOnlyReason } from '../../ipc';
import { Icon } from '../../ui/Icon';
import { useTabTransaction } from '../query/executionStore';
import { readOnlyReasons } from './resultEditModel';
import styles from './ResultEdit.module.css';
import { editTableLabel, type ResultEditEntry } from './resultEdits';

/**
 * Whether a result can be edited, in its footer (F-087): "Editable · table", or "Read-only"
 * with the reason (the first one; all of them on hover).
 */
export function ResultEditStatus({ entry }: { entry: ResultEditEntry | undefined }) {
  const t = useT();
  const transaction = useTabTransaction(entry?.tabId ?? '');
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
  if (reasons.length > 0) {
    const all = reasons.map(text).join(' ');
    return (
      <span
        className={styles.readOnly}
        title={all}
        data-testid="result-edit-status"
        data-editable="false"
      >
        <Icon name="lock" />
        <strong>{t('resultEdit.readOnly')}</strong>
        <span className={styles.reason}>{reasons[0] ? text(reasons[0]) : ''}</span>
      </span>
    );
  }
  const table = editTableLabel(entry);
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
