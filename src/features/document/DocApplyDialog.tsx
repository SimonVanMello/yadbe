import { useEffect, useState } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import type { DocConflict } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Spinner } from '../../ui/Spinner';
import { ConnectionBanner } from '../connections/ConnectionBanner';
import { useConnection } from '../connections/connectionStore';
import { showJournalEntry } from '../journal/journalStore';
import {
  applyDocDialog,
  closeDocApply,
  defaultChoice,
  installDocCloseGuard,
  resolveDocConflicts,
  type DocConflictChoice,
} from './docEditActions';
import { pathText } from './docEditModel';
import { useDocEditStore } from './docEditStore';
import { ejsonDocument } from './ejsonView';
import styles from './DocEdit.module.css';

/** A value of a conflict as the documents view writes it. */
function shown(text: string | null, missing: string): string {
  if (text === null) return missing;
  const node = ejsonDocument(text);
  return node.type === 'scalar' ? node.text : text;
}

/**
 * The apply dialog of document edits (M4-4): the operations as they will run, in mongosh
 * syntax, in one transaction or one by one (and why); the conflicts when documents changed on
 * the server (keep mine or take theirs); what was applied before a stop on a standalone
 * server. Also the revert of a document journal entry. Mount once.
 */
export function DocApplyDialog() {
  const t = useT();
  useEffect(() => {
    installDocCloseGuard();
  }, []);
  const dialog = useDocEditStore((state) => state.dialog);
  const connection = useConnection(dialog?.connectionId ?? null);
  const [picked, setPicked] = useState<{
    conflicts: readonly DocConflict[] | null;
    map: ReadonlyMap<number, DocConflictChoice>;
  }>({ conflicts: null, map: new Map() });
  if (!dialog) return null;
  const choices =
    picked.conflicts === dialog.conflicts ? picked.map : new Map<number, DocConflictChoice>();
  const choiceOf = (c: DocConflict) => choices.get(c.edit) ?? defaultChoice(c);
  const prod = connection?.environment === 'prod';
  const revert = dialog.source.kind === 'revert';
  const preview = dialog.preview;
  const count = preview?.operations ?? 0;
  const status = dialog.status;
  const conflicted = status === 'conflicted';
  const outcome = dialog.outcome;
  const applied = outcome?.applied.length ?? 0;
  const missing = t('mongo.conflict.missing');

  const title = revert
    ? t('journal.revert.title', { id: dialog.source.kind === 'revert' ? dialog.source.entryId : 0 })
    : conflicted
      ? t('mongo.conflict.title', { count: dialog.conflicts.length })
      : t('mongo.apply.title', { name: dialog.label });

  const description = conflicted
    ? outcome?.atomic
      ? t('mongo.conflict.atomic')
      : t('mongo.conflict.oneByOne', { count: applied })
    : preview
      ? preview.atomic
        ? t('mongo.apply.atomic', { count })
        : t('mongo.apply.oneByOne', { count })
      : undefined;

  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) closeDocApply();
      }}
      title={title}
      description={description}
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
          <Button variant="ghost" onClick={closeDocApply}>
            {conflicted || status === 'failed' || status === 'uncertain'
              ? t('common.close')
              : t('common.cancel')}
          </Button>
          {outcome?.journalId != null && (
            <Button
              variant="ghost"
              onClick={() => {
                const id = outcome.journalId;
                closeDocApply();
                if (id !== null) showJournalEntry(id);
              }}
            >
              {t('journal.showEntry')}
            </Button>
          )}
          {conflicted && !revert && (
            <Button
              variant={prod ? 'danger' : 'primary'}
              onClick={() => {
                void resolveDocConflicts(
                  new Map(dialog.conflicts.map((c) => [c.edit, choiceOf(c)] as const)),
                );
              }}
            >
              <Icon name="check" />
              {t('mongo.conflict.resolve')}
            </Button>
          )}
          {(status === 'ready' || status === 'applying') && (
            <Button
              variant={prod ? 'danger' : 'primary'}
              disabled={status === 'applying'}
              onClick={() => {
                void applyDocDialog();
              }}
            >
              {status === 'applying' ? <Spinner /> : <Icon name={revert ? 'undo' : 'check'} />}
              {revert ? t('journal.revert.apply', { count }) : t('mongo.apply.button', { count })}
            </Button>
          )}
        </>
      }
    >
      <div className={styles.body} data-testid="doc-apply-dialog">
        {connection && <ConnectionBanner connection={connection} />}
        {status === 'loading' && (
          <div className={styles.loading}>
            <Spinner />
            {t('tableData.preview.loading')}
          </div>
        )}
        {preview && !preview.atomic && !conflicted && status !== 'failed' && (
          <p className={styles.warning} role="note" data-testid="doc-not-atomic">
            <Icon name="warning" />
            {t('mongo.apply.notAtomic')}
          </p>
        )}
        {(status === 'failed' || status === 'uncertain') && (
          <div className={styles.failure} role="alert" data-testid="doc-apply-failure">
            <p>
              <Icon name="warning" />
              {status === 'uncertain'
                ? t('mongo.apply.uncertain')
                : outcome
                  ? outcome.atomic || applied === 0
                    ? t('mongo.apply.failedNothing')
                    : t('mongo.apply.failedPartial', { count: applied })
                  : t('mongo.apply.failed')}
            </p>
            {dialog.error && <p className={styles.note}>{localize(dialog.error.message)}</p>}
            {dialog.error?.detail && <code className={styles.detail}>{dialog.error.detail}</code>}
            {outcome?.retryable && <p className={styles.note}>{t('mongo.apply.retryable')}</p>}
          </div>
        )}
        {conflicted && (
          <div className={styles.conflicts} role="alert" data-testid="doc-conflicts">
            {dialog.conflicts.map((conflict) => (
              <section key={conflict.edit} className={styles.conflict}>
                <header className={styles.conflictHeader}>
                  <span className={styles.conflictTitle}>
                    <Icon name="warning" className={styles.conflictIcon} />
                    <code>{shown(conflict.id, missing)}</code>
                  </span>
                  {!revert && conflict.kind === 'changed' && (
                    <SegmentedControl<DocConflictChoice>
                      label={t('mongo.conflict.choice', { id: shown(conflict.id, missing) })}
                      value={choiceOf(conflict)}
                      options={[
                        { value: 'mine', label: t('keyValue.conflict.mine') },
                        { value: 'theirs', label: t('keyValue.conflict.theirs') },
                      ]}
                      onChange={(value) => {
                        setPicked({
                          conflicts: dialog.conflicts,
                          map: new Map(choices).set(conflict.edit, value),
                        });
                      }}
                    />
                  )}
                </header>
                <p className={styles.note}>{t(`mongo.conflict.kind.${conflict.kind}`)}</p>
                {conflict.fields.length > 0 && (
                  <table className={styles.values}>
                    <thead>
                      <tr>
                        <th>{t('mongo.conflict.field')}</th>
                        <th>{t('keyValue.conflict.seen')}</th>
                        <th>{t('keyValue.conflict.now')}</th>
                        <th>{t('keyValue.conflict.yours')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {conflict.fields.map((field) => (
                        <tr key={pathText(field.path)}>
                          <td>
                            <code>{pathText(field.path)}</code>
                          </td>
                          <td>{shown(field.seen, missing)}</td>
                          <td data-kind="theirs">{shown(field.now, missing)}</td>
                          <td data-kind="mine">{shown(field.yours, missing)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            ))}
          </div>
        )}
        {preview && !conflicted && (
          <>
            <pre
              className={styles.commands}
              aria-label={t('mongo.apply.operations')}
              data-testid="doc-operations"
            >
              {preview.lines.map((line, i) => (
                <code key={i} className={styles.line} data-role={line.role}>
                  {line.text}
                </code>
              ))}
            </pre>
            <p className={styles.legend}>{t('mongo.apply.legend')}</p>
          </>
        )}
      </div>
    </Dialog>
  );
}
