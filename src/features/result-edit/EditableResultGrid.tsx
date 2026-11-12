import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { shortcutOf } from '../../app/actions';
import { useT } from '../../i18n/useT';
import type { ResultSummary, TableDataInfo } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { Spinner } from '../../ui/Spinner';
import type { ConnectionSummary } from '../connections/model';
import { useExportStore } from '../export/exportStore';
import type { ExportGridRange } from '../export/exportOptions';
import { DataGrid, type DataGridApi } from '../grid/DataGrid';
import { openResultExport, ResultFooter } from '../grid/ResultFooter';
import { useResultSelectionStore, type SelectionSize } from '../grid/resultSelectionStore';
import { useTabTransaction } from '../query/executionStore';
import { ConflictDialog } from '../table-data/ConflictDialog';
import { FailureBanner } from '../table-data/FailureBanner';
import { PreviewDialog } from '../table-data/PreviewDialog';
import {
  flushEditor,
  openPreview,
  registerGrid,
  requestApply,
  revertAll,
} from '../table-data/tableActions';
import type { TableRowSource } from '../table-data/tableRowSource';
import { useTableSession } from '../table-data/tableSessionStore';
import { useCellEditing } from '../table-data/useCellEditing';
import { ResultEditMenu } from './ResultEditMenu';
import styles from './ResultEdit.module.css';
import { ResultEditStatus } from './ResultEditStatus';
import { growResult, useResultEdit } from './resultEdits';
import { sessionIdOf } from './resultEditModel';

interface EditableResultGridProps {
  resultId: number;
  summary: ResultSummary;
  label: string;
  info: TableDataInfo;
  source: TableRowSource;
  connection: ConnectionSummary;
}

/**
 * A result of a `SELECT` on one table holding its key, edited like a table tab (F-087): cell
 * editors, `NULL`, row deletion, pending changes drawn over the rows, the SQL preview and Apply
 * in one transaction, the conflicts of rows changed elsewhere. Rows cannot be added.
 */
export function EditableResultGrid({
  resultId,
  summary,
  label,
  info,
  source,
  connection,
}: EditableResultGridProps) {
  const t = useT();
  const id = sessionIdOf(resultId);
  const session = useTableSession(id);
  const entry = useResultEdit(resultId);
  const transaction = useTabTransaction(entry?.tabId ?? '');
  const apiRef = useRef<DataGridApi | null>(null);

  useLayoutEffect(() => {
    growResult(resultId, summary.rowCount);
  }, [resultId, summary.rowCount]);

  const setApi = useCallback(
    (api: DataGridApi | null) => {
      apiRef.current = api;
      registerGrid(id, api);
    },
    [id],
  );
  useEffect(
    () => () => {
      registerGrid(id, null);
      useResultSelectionStore.getState().clear(resultId);
      useExportStore.getState().forgetRange(resultId);
    },
    [id, resultId],
  );

  const { editing } = useCellEditing({
    tabId: id,
    columns: info.columns,
    source,
    apiRef,
    editable: true,
  });

  const onSelectionSize = useCallback(
    (size: SelectionSize | null) => {
      useResultSelectionStore.getState().report(resultId, size);
    },
    [resultId],
  );
  const onSelectionRange = useCallback(
    (range: ExportGridRange | null) => {
      useExportStore.getState().setRange(resultId, range);
    },
    [resultId],
  );

  const pending = session.pendingCount;
  const blocked = transaction.status !== 'idle';
  const footer = (
    <>
      <ResultFooter resultId={resultId} summary={summary} label={label} />
      <ResultEditStatus entry={entry} />
      {session.stale && (
        <span className={styles.stale} role="status">
          {t('resultEdit.stale')}
        </span>
      )}
      {pending > 0 && (
        <span className={styles.actions}>
          <span className={styles.pending} data-testid="result-pending">
            {t('tableData.pending', { count: pending })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void revertAll(id);
            }}
          >
            {t('resultEdit.revertAll')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void flushEditor(id).then(() => openPreview(id));
            }}
          >
            {t('resultEdit.preview')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={session.applying || blocked}
            onClick={() => {
              void flushEditor(id).then(() => {
                requestApply(id);
              });
            }}
          >
            {session.applying ? <Spinner /> : <Icon name="check" />}
            {t('resultEdit.apply')}
            <Kbd shortcut={shortcutOf('table.apply')} />
          </Button>
        </span>
      )}
    </>
  );

  return (
    <div className={styles.view} data-result-edit={id}>
      <DataGrid
        source={source}
        sourceKey={`result-edit-${String(resultId)}-${String(session.pageVersion)}-${String(session.editVersion)}`}
        label={label}
        footer={footer}
        emptyText={summary.status === 'streaming' ? undefined : t('grid.noRows')}
        editing={editing}
        apiRef={setApi}
        menuExtras={<ResultEditMenu sessionId={id} />}
        onSelectionSize={onSelectionSize}
        onSelectionRange={onSelectionRange}
        onExport={() => {
          openResultExport(resultId, summary, label);
        }}
      />
      {session.failure && (
        <FailureBanner
          tabId={id}
          failure={session.failure.failure}
          target={session.failure.target}
        />
      )}
      <PreviewDialog tabId={id} connection={connection} />
      <ConflictDialog tabId={id} connection={connection} />
    </div>
  );
}
