import { useT } from '../../i18n/useT';
import { localize } from '../../app/errors/presentError';
import type { ObjectRef } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import type { ConnectionSummary } from '../connections/model';
import { FailureBanner } from './FailureBanner';
import { FilterBar } from './FilterBar';
import { ConflictDialog } from './ConflictDialog';
import { PreviewDialog } from './PreviewDialog';
import { RevertDialog } from './RevertDialog';
import { openTable, tableReasonText, tableSource } from './tableActions';
import { TableGrid } from './TableGrid';
import { tableLabel } from './tableNames';
import { useTableSession } from './tableSessionStore';
import { TableStrip } from './TableStrip';
import styles from './TableView.module.css';

interface TableViewProps {
  tabId: string;
  table: ObjectRef;
  connection: ConnectionSummary;
}

/**
 * A table tab once connected (F-080 to F-086): why it is read-only when it is, the filter bar,
 * the page strip, the rows, what failed in the last apply, and the SQL preview.
 */
export function TableView({ tabId, table, connection }: TableViewProps) {
  const t = useT();
  const session = useTableSession(tabId);
  const { info, phase, error, failure } = session;
  const source = info ? tableSource(tabId) : undefined;

  return (
    <div className={styles.view}>
      {info && info.readOnlyReasons.length > 0 && (
        <div className={styles.readOnly} role="note" data-testid="table-readonly">
          <Icon name="lock" />
          <span className={styles.readOnlyText}>
            <strong>{t('tableData.readOnly.title')}</strong>{' '}
            {info.readOnlyReasons.map(tableReasonText).join(' ')}
          </span>
        </div>
      )}
      {info && <FilterBar tabId={tabId} info={info} />}
      {info && <TableStrip tabId={tabId} />}
      <div className={styles.gridArea}>
        {error && (
          <div className={source ? styles.errorStrip : styles.placeholder} role="alert">
            <Icon name="error" className={styles.errorIcon} />
            <span>{localize(error.message)}</span>
            <Button
              size="sm"
              onClick={() => {
                void openTable(tabId);
              }}
            >
              {t('error.action.retry')}
            </Button>
          </div>
        )}
        {!source && !error && (phase === 'opening' || phase === 'idle') && (
          <div className={styles.placeholder}>
            <Spinner />
          </div>
        )}
        {info && source && (
          <TableGrid
            tabId={tabId}
            info={info}
            source={source}
            label={t('tableData.grid.label', { table: tableLabel(table) })}
          />
        )}
      </div>
      {failure && <FailureBanner tabId={tabId} failure={failure.failure} target={failure.target} />}
      <PreviewDialog tabId={tabId} connection={connection} />
      <ConflictDialog tabId={tabId} connection={connection} />
      <RevertDialog tabId={tabId} connection={connection} />
    </div>
  );
}
