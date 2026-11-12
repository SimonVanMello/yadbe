import { useEffect, useState } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import type { KvConflict } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Spinner } from '../../ui/Spinner';
import { ConnectionBanner } from '../connections/ConnectionBanner';
import { useConnection } from '../connections/connectionStore';
import {
  applyDialog,
  closeApplyDialog,
  installKvCloseGuard,
  resolveConflicts,
  type KvConflictChoice,
} from './kvEditActions';
import { describeEdit, editValueText, rebase } from './kvEditModel';
import { useKvEditStore } from './kvEditStore';
import styles from './KeyEdit.module.css';

/**
 * The apply dialog of key edits (M4-6): the commands as they will run (`WATCH`, the checks,
 * `MULTI` … `EXEC`), the dangers to confirm with their effect, and the conflicts when the
 * server no longer holds what the user saw (keep mine, take theirs, keep editing). Also the
 * revert of a key-value journal entry. Mount once.
 */
export function KvApplyDialog() {
  const t = useT();
  useEffect(() => {
    installKvCloseGuard();
  }, []);
  const dialog = useKvEditStore((state) => state.dialog);
  const tabKey = useKvEditStore((state) =>
    state.dialog?.source.kind === 'tab' ? state.tabs[state.dialog.source.tabId]?.key : undefined,
  );
  const connection = useConnection(dialog?.connectionId ?? null);
  // The choices made for the conflicts on screen; other conflicts start without any.
  const [picked, setPicked] = useState<{
    conflicts: readonly KvConflict[] | null;
    map: ReadonlyMap<number, KvConflictChoice>;
  }>({ conflicts: null, map: new Map() });
  if (!dialog) return null;
  const choices =
    picked.conflicts === dialog.conflicts ? picked.map : new Map<number, KvConflictChoice>();
  const prod = connection?.environment === 'prod';
  const revert = dialog.source.kind === 'revert';
  const preview = dialog.preview;
  const count = preview?.commands ?? 0;
  const conflicted = dialog.status === 'conflicted';
  const confirming = dialog.status === 'confirm';
  const dangers = dialog.dangers;

  const choiceOf = (conflict: KvConflict): KvConflictChoice => {
    if (revert) return 'edit';
    const edit = dialog.edits[conflict.edit];
    const canKeep = edit !== undefined && rebase(edit, conflict) !== null;
    return choices.get(conflict.edit) ?? (canKeep ? 'edit' : 'theirs');
  };
  const labels: Record<KvConflictChoice, string> = {
    mine: t('keyValue.conflict.mine'),
    theirs: t('keyValue.conflict.theirs'),
    edit: t('keyValue.conflict.edit'),
  };

  const title = revert
    ? t('journal.revert.title', {
        id: dialog.source.kind === 'revert' ? dialog.source.entryId : 0,
      })
    : conflicted
      ? t('keyValue.conflict.title', { count: dialog.conflicts.length })
      : t('keyValue.apply.title', { key: tabKey?.text ?? '' });

  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) closeApplyDialog();
      }}
      title={title}
      description={
        conflicted
          ? revert
            ? t('keyValue.conflict.revertDescription')
            : t('keyValue.conflict.description')
          : preview
            ? t(revert ? 'keyValue.revert.description' : 'keyValue.apply.description', {
                count,
              })
            : undefined
      }
      notice={
        prod ? (
          <span className={styles.prod} role="note">
            <Icon name="shield" />
            {t('tableData.preview.prod')}
          </span>
        ) : undefined
      }
      footer={
        <>
          <Button variant="ghost" onClick={closeApplyDialog}>
            {conflicted && revert ? t('common.close') : t('common.cancel')}
          </Button>
          {conflicted && !revert && (
            <Button
              variant={prod ? 'danger' : 'primary'}
              onClick={() => {
                const resolved = new Map(
                  dialog.conflicts.map((c) => [c.edit, choiceOf(c)] as const),
                );
                void resolveConflicts(resolved);
              }}
            >
              <Icon name="check" />
              {t('keyValue.conflict.resolve')}
            </Button>
          )}
          {!conflicted && (
            <Button
              variant={prod || confirming || dangers.length > 0 ? 'danger' : 'primary'}
              disabled={
                dialog.status === 'loading' ||
                dialog.status === 'applying' ||
                dialog.status === 'failed'
              }
              onClick={() => {
                void applyDialog(true);
              }}
            >
              {dialog.status === 'applying' ? (
                <Spinner />
              ) : (
                <Icon name={revert ? 'undo' : 'check'} />
              )}
              {revert
                ? t('journal.revert.apply', { count })
                : dangers.length > 0
                  ? t('keyValue.apply.confirm', { count })
                  : t('keyValue.apply.button', { count })}
            </Button>
          )}
        </>
      }
    >
      <div className={styles.body} data-testid="kv-apply-dialog">
        {connection && (
          <ConnectionBanner connection={{ ...connection, database: String(dialog.database) }} />
        )}
        {dialog.status === 'loading' && (
          <div className={styles.loading}>
            <Spinner />
            {t('tableData.preview.loading')}
          </div>
        )}
        {dialog.status === 'failed' && dialog.error && (
          <p className={styles.error} role="alert">
            {localize(dialog.error.message)}
          </p>
        )}
        {dangers.length > 0 && !conflicted && (
          <ul className={styles.dangers} aria-label={t('keyValue.apply.dangers')}>
            {dangers.map((danger, i) => (
              <li key={i} className={styles.danger}>
                <Icon name="warning" className={styles.dangerIcon} />
                {localize(danger.effect)}
              </li>
            ))}
          </ul>
        )}
        {conflicted && (
          <div className={styles.conflicts} role="alert" data-testid="kv-conflicts">
            {dialog.conflicts.map((conflict) => {
              const edit = dialog.edits[conflict.edit];
              const what = edit ? describeEdit(edit) : null;
              const canKeep = !revert && edit !== undefined && rebase(edit, conflict) !== null;
              const options: KvConflictChoice[] = canKeep
                ? ['mine', 'theirs', 'edit']
                : ['theirs', 'edit'];
              return (
                <section key={conflict.edit} className={styles.conflict}>
                  <header className={styles.conflictHeader}>
                    <span className={styles.conflictTitle}>
                      <Icon name="warning" className={styles.conflictIcon} />
                      <code>{conflict.key.text}</code>
                      {what && <span>{t(what.key, what.params)}</span>}
                    </span>
                    {!revert && (
                      <SegmentedControl
                        label={t('keyValue.conflict.choice', { key: conflict.key.text })}
                        value={choiceOf(conflict)}
                        options={options.map((value) => ({ value, label: labels[value] }))}
                        onChange={(value) => {
                          setPicked({
                            conflicts: dialog.conflicts,
                            map: new Map(choices).set(conflict.edit, value),
                          });
                        }}
                      />
                    )}
                  </header>
                  <p className={styles.note}>
                    {t(`keyValue.conflict.kind.${conflict.kind}`, {
                      type: conflict.actualType ?? '',
                    })}
                  </p>
                  {(conflict.expected !== null || conflict.current !== null) && (
                    <dl className={styles.values}>
                      <dt>{t('keyValue.conflict.seen')}</dt>
                      <dd>{conflict.expected ?? t('keyValue.conflict.nothing')}</dd>
                      <dt>{t('keyValue.conflict.now')}</dt>
                      <dd data-kind="theirs">
                        {conflict.current?.text ?? t('keyValue.conflict.nothing')}
                      </dd>
                      {edit && editValueText(edit) !== null && (
                        <>
                          <dt>{t('keyValue.conflict.yours')}</dt>
                          <dd data-kind="mine">{editValueText(edit)}</dd>
                        </>
                      )}
                    </dl>
                  )}
                </section>
              );
            })}
          </div>
        )}
        {preview && !conflicted && (
          <>
            {preview.batches > 1 && (
              <p className={styles.note}>
                {t('keyValue.apply.batches', { count: preview.batches })}
              </p>
            )}
            <pre
              className={styles.commands}
              aria-label={t('keyValue.apply.commands')}
              data-testid="kv-commands"
            >
              {preview.lines.map((line, i) => (
                <code key={i} className={styles.line} data-role={line.role}>
                  {line.text}
                </code>
              ))}
            </pre>
            <p className={styles.legend}>{t('keyValue.apply.legend')}</p>
          </>
        )}
      </div>
    </Dialog>
  );
}
