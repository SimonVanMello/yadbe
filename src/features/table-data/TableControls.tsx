import { useShortcutOf } from '../../app/useShortcutOf';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Spinner } from '../../ui/Spinner';
import { Tooltip } from '../../ui/Tooltip';
import { ConnectionChip } from '../connections/ConnectionChip';
import { useConnectionState } from '../connections/connectionStore';
import type { ConnectionSummary } from '../connections/model';
import {
  deleteSelectedRows,
  duplicateRows,
  flushEditor,
  insertRow,
  openPreview,
  requestApply,
  revertAll,
} from './tableActions';
import styles from './TableControls.module.css';
import { useTableSession } from './tableSessionStore';

/**
 * The table-tab part of the toolbar (F-083 to F-085): rows (insert, duplicate, delete), the
 * pending changes (count, revert, preview, apply) and the connection chip, environment
 * included. The table tab is bound to its connection and database: the chip does not switch.
 */
export function TableControls({
  tabId,
  connection,
}: {
  tabId: string;
  connection: ConnectionSummary;
}) {
  const shortcutOf = useShortcutOf();
  const t = useT();
  const state = useConnectionState(connection.id);
  const { info, pendingCount, applying } = useTableSession(tabId);
  const editable = !!info && info.readOnlyReasons.length === 0;
  const pending = pendingCount > 0;
  const shown = info ? { ...connection, database: info.table.database } : connection;

  return (
    <>
      <span className={styles.group} role="group" aria-label={t('tableData.toolbar.rows')}>
        <IconButton
          icon="plus"
          label={t('action.table.insertRow')}
          shortcut={shortcutOf('table.insertRow')}
          disabled={!editable}
          onClick={() => {
            insertRow(tabId);
          }}
        />
        <IconButton
          icon="copy"
          label={t('action.table.duplicateRows')}
          shortcut={shortcutOf('table.duplicateRows')}
          disabled={!editable}
          onClick={() => {
            void duplicateRows(tabId);
          }}
        />
        <IconButton
          icon="trash"
          label={t('action.table.deleteRows')}
          shortcut={shortcutOf('table.deleteRows')}
          disabled={!editable}
          onClick={() => {
            void deleteSelectedRows(tabId);
          }}
        />
      </span>
      <span className={styles.separator} aria-hidden="true" />
      <span className={styles.group} role="group" aria-label={t('tableData.toolbar.changes')}>
        <span
          className={styles.pending}
          data-pending={pending || undefined}
          role="status"
          data-testid="toolbar-pending"
        >
          {pending ? t('tableData.pending', { count: pendingCount }) : t('tableData.noPending')}
        </span>
        <IconButton
          icon="undo"
          label={t('action.table.revertAll')}
          disabled={!pending || applying}
          onClick={() => {
            void revertAll(tabId);
          }}
        />
        <Button
          size="sm"
          disabled={!pending || applying}
          onClick={() => {
            void flushEditor(tabId).then(() => openPreview(tabId));
          }}
        >
          <Icon name="eye" />
          {t('action.table.preview')}
        </Button>
        <Tooltip content={t('action.table.apply')} shortcut={shortcutOf('table.apply')}>
          <Button
            variant="primary"
            size="sm"
            disabled={!pending || applying}
            onClick={() => {
              void flushEditor(tabId).then(() => {
                requestApply(tabId);
              });
            }}
          >
            {applying ? <Spinner /> : <Icon name="check" />}
            {t('tableData.apply.button')}
          </Button>
        </Tooltip>
      </span>
      <span className={styles.separator} aria-hidden="true" />
      <ConnectionChip connection={shown} state={state} />
    </>
  );
}
