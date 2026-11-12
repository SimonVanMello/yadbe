import { useState } from 'react';

import { useT } from '../../i18n/useT';
import type { Value } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { ConnectionBanner } from '../connections/ConnectionBanner';
import type { ConnectionSummary } from '../connections/model';
import { editText } from './cellValues';
import styles from './ConflictDialog.module.css';
import {
  closeConflicts,
  conflictChoices,
  resolveConflicts,
  type ConflictChoice,
} from './tableActions';
import { useTableSession, type ConflictRow } from './tableSessionStore';

/** How a value reads in the comparison: `NULL`, or its text cut to one line. */
function shown(value: Value | null, missing: string): string {
  if (value === null) return missing;
  if (value.kind === 'null') return 'NULL';
  const text = editText(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/**
 * Rows changed or deleted by someone else since they were read (F-089): nothing was applied.
 * Each shows its cells as read, as the user wants them and as stored now, with a choice: keep
 * mine (overwrite theirs on the next Apply), take theirs (drop my change), keep editing.
 */
export function ConflictDialog({
  tabId,
  connection,
}: {
  tabId: string;
  connection: ConnectionSummary;
}) {
  const t = useT();
  const { conflict, info } = useTableSession(tabId);
  const [choices, setChoices] = useState<ReadonlyMap<number, ConflictChoice>>(new Map());
  if (!conflict) return null;

  const choiceOf = (row: ConflictRow): ConflictChoice =>
    // Nothing is overwritten unless asked: "keep editing" until a choice is made.
    row.current ? (choices.get(row.row) ?? 'edit') : 'theirs';
  const editing = conflict.rows.some((row) => choiceOf(row) === 'edit');
  const labels: Record<ConflictChoice, string> = {
    mine: t('tableData.conflict.mine'),
    theirs: t('tableData.conflict.theirs'),
    edit: t('tableData.conflict.edit'),
  };

  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) closeConflicts(tabId);
      }}
      title={t('tableData.conflict.title', { count: conflict.rows.length })}
      description={t('tableData.conflict.description')}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              closeConflicts(tabId);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant={connection.environment === 'prod' ? 'danger' : 'primary'}
            onClick={() => {
              const resolved = new Map(conflict.rows.map((row) => [row.row, choiceOf(row)]));
              resolveConflicts(tabId, resolved);
            }}
          >
            <Icon name="check" />
            {editing ? t('tableData.conflict.resolve') : t('tableData.conflict.resolveApply')}
          </Button>
        </>
      }
    >
      <div className={styles.body} data-testid="conflict-dialog">
        <ConnectionBanner
          connection={{ ...connection, database: info?.table.database ?? connection.database }}
        />
        {conflict.rows.map((row) => (
          <section key={row.row} className={styles.row} aria-label={row.label}>
            <header className={styles.rowHeader}>
              <div className={styles.rowTitle}>
                <Icon name={row.current ? 'warning' : 'trash'} className={styles.rowIcon} />
                <code>{row.label}</code>
                <span className={styles.rowState}>
                  {row.current
                    ? t(`tableData.conflict.changed.${row.kind}`)
                    : t(`tableData.conflict.deleted.${row.kind}`)}
                </span>
              </div>
              {row.current ? (
                <SegmentedControl
                  label={t('tableData.conflict.choice', { row: row.label })}
                  value={choiceOf(row)}
                  options={conflictChoices(row).map((value) => ({ value, label: labels[value] }))}
                  onChange={(value) => {
                    setChoices((current) => new Map(current).set(row.row, value));
                  }}
                />
              ) : (
                <span className={styles.gone}>{t('tableData.conflict.dropped')}</span>
              )}
            </header>
            {row.cells.length > 0 && (
              <table className={styles.cells}>
                <thead>
                  <tr>
                    <th scope="col">{t('tableData.conflict.column')}</th>
                    <th scope="col">{t('tableData.conflict.original')}</th>
                    <th scope="col">{t('tableData.conflict.yours')}</th>
                    <th scope="col">{t('tableData.conflict.current')}</th>
                  </tr>
                </thead>
                <tbody>
                  {row.cells.map((cell) => (
                    <tr key={cell.column} data-edited={cell.edited || undefined}>
                      <th scope="row">{cell.column}</th>
                      <td>{shown(cell.original, '')}</td>
                      <td data-kind="mine">
                        {shown(cell.mine, t('tableData.conflict.deletedValue'))}
                      </td>
                      <td data-kind="theirs">
                        {shown(cell.theirs, t('tableData.conflict.deletedValue'))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}
      </div>
    </Dialog>
  );
}
