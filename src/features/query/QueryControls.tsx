import { shortcutOf } from '../../app/actions';
import { useT } from '../../i18n/useT';
import type { TransactionMode } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Menu } from '../../ui/Menu';
import { MenuItem } from '../../ui/MenuItem';
import { Select } from '../../ui/Select';
import { Tooltip } from '../../ui/Tooltip';
import type { ConnectionSummary } from '../connections/model';
import { ConnectionSwitcher } from './ConnectionSwitcher';
import { useTabCanRun, useTabRunning, useTabTransaction } from './executionStore';
import {
  cancelQuery,
  commitTransaction,
  openScript,
  rollbackTransaction,
  runQuery,
  saveScript,
  setTransactionMode,
} from './queryActions';
import styles from './QueryControls.module.css';
import { useIsDirty, useQueryTabState } from './queryTabStore';
import { runLabelKey, selectedRange } from './runScope';

interface QueryControlsProps {
  tabId: string;
  connection: ConnectionSummary | undefined;
}

/**
 * The query-specific part of the toolbar: Run / Cancel (F-041, F-042), the transaction controls
 * (F-047), open / save (F-045) and the connection switcher (F-046).
 */
export function QueryControls({ tabId, connection }: QueryControlsProps) {
  const t = useT();
  const running = useTabRunning(tabId);
  const canRun = useTabCanRun(tabId);
  const { selection } = useQueryTabState(tabId);
  const hasSelection = selectedRange(selection) !== null;
  const dirty = useIsDirty(tabId);
  const { filePath } = useQueryTabState(tabId);

  return (
    <>
      <span className={styles.group}>
        <Tooltip content={t(runLabelKey(selection))} shortcut={shortcutOf('query.run')}>
          <Button
            variant="primary"
            size="sm"
            className={styles.run}
            disabled={!canRun}
            onClick={() => {
              void runQuery(tabId, 'auto');
            }}
          >
            <Icon name="play" />
            {t(runLabelKey(selection))}
          </Button>
        </Tooltip>
        <Menu
          align="start"
          trigger={
            <IconButton
              icon="chevronDown"
              size="sm"
              label={t('toolbar.runMenu')}
              disabled={!canRun}
              className={styles.runMenu}
            />
          }
        >
          <MenuItem
            icon="play"
            onSelect={() => {
              void runQuery(tabId, 'all');
            }}
          >
            {t('toolbar.runAll')}
          </MenuItem>
          <MenuItem
            icon="play"
            disabled={!hasSelection}
            onSelect={() => {
              void runQuery(tabId, 'selection');
            }}
          >
            {t('toolbar.runSelectionOnly')}
          </MenuItem>
          <MenuItem
            icon="play"
            shortcut={shortcutOf('query.runStatement')}
            onSelect={() => {
              void runQuery(tabId, 'statement');
            }}
          >
            {t('toolbar.runStatement')}
          </MenuItem>
        </Menu>
      </span>
      <Tooltip content={t('toolbar.cancel')} shortcut={shortcutOf('query.cancel')}>
        <Button
          size="sm"
          disabled={!running}
          onClick={() => {
            cancelQuery(tabId);
          }}
        >
          <Icon name="stop" />
          {t('toolbar.cancel')}
        </Button>
      </Tooltip>
      <span className={styles.separator} aria-hidden="true" />
      <TransactionControls tabId={tabId} running={running} />
      <span className={styles.separator} aria-hidden="true" />
      <IconButton
        icon="folderOpen"
        label={t('toolbar.openFile')}
        shortcut={shortcutOf('query.open')}
        onClick={() => {
          void openScript(tabId);
        }}
      />
      <IconButton
        icon="save"
        label={dirty || filePath === null ? t('toolbar.saveFile') : t('toolbar.saveFileUnchanged')}
        shortcut={shortcutOf('query.save')}
        onClick={() => {
          void saveScript(tabId);
        }}
      />
      <span className={styles.separator} aria-hidden="true" />
      {connection ? <ConnectionSwitcher tabId={tabId} connection={connection} /> : null}
    </>
  );
}

function TransactionControls({ tabId, running }: { tabId: string; running: boolean }) {
  const t = useT();
  const { mode, status } = useTabTransaction(tabId);
  const open = status !== 'idle';
  return (
    <span className={styles.group} role="group" aria-label={t('query.transaction.label')}>
      <Select<TransactionMode>
        className={styles.mode}
        aria-label={t('query.transaction.mode')}
        value={mode}
        disabled={running || open}
        options={[
          { value: 'autoCommit', label: t('query.transaction.autoCommit') },
          { value: 'manual', label: t('query.transaction.manual') },
        ]}
        onChange={(next) => {
          void setTransactionMode(tabId, next);
        }}
      />
      <Button
        size="sm"
        disabled={!open || running}
        onClick={() => {
          void commitTransaction(tabId);
        }}
      >
        <Icon name="check" />
        {t('query.transaction.commit')}
      </Button>
      <Button
        size="sm"
        disabled={!open || running}
        onClick={() => {
          void rollbackTransaction(tabId);
        }}
      >
        <Icon name="undo" />
        {t('query.transaction.rollback')}
      </Button>
      {open && (
        <span className={styles.badge} data-status={status} role="status">
          {t(status === 'failed' ? 'query.transaction.failed' : 'query.transaction.open')}
        </span>
      )}
    </span>
  );
}
