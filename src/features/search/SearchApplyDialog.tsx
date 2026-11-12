import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import type { SearchEdit } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { ConnectionBanner } from '../connections/ConnectionBanner';
import { useConnection } from '../connections/connectionStore';
import { applySearchDialog, closeSearchApply, keepMine, takeTheirs } from './searchEditActions';
import { blockText, describe } from './searchEditModel';
import { useSearchEditStore } from './searchEditStore';
import styles from './SearchEdit.module.css';

/** The `_source` an edit writes, indented; `null` for a delete. */
function editSource(edit: SearchEdit | undefined): string | null {
  if (!edit || edit.kind === 'delete') return null;
  try {
    return JSON.stringify(JSON.parse(edit.source), null, 2);
  } catch {
    return edit.source;
  }
}

/**
 * The apply dialog of document edits (M4-8): the requests as they will be sent, in console
 * syntax (guarded by `if_seq_no` / `if_primary_term`, creates with `op_type=create`), why they
 * are sent one at a time, the edits refused here; after an apply that stopped, what was
 * applied and the conflict (my version against the server's) or the failure. Also the revert
 * of a search journal entry. Mount once.
 */
export function SearchApplyDialog() {
  const t = useT();
  const dialog = useSearchEditStore((state) => state.dialog);
  const connection = useConnection(dialog?.connectionId ?? null);
  if (!dialog) return null;
  const revert = dialog.source.kind === 'revert';
  const { preview, outcome, changes } = dialog;
  const count = changes.edits.length;
  const prod = connection?.environment === 'prod';
  const stop = outcome?.stopped ?? null;
  const conflict = stop?.reason.kind === 'conflict' ? stop.reason.conflict : null;
  const stoppedEdit = stop ? changes.edits[stop.edit] : undefined;
  const refused = preview?.refused ?? [];
  const appliedCount = outcome?.applied.length ?? 0;

  const stateOf = (edit: number): 'applied' | 'stopped' | 'refused' | 'pending' => {
    if (outcome && edit < appliedCount) return 'applied';
    if (stop?.edit === edit) return 'stopped';
    if (refused.some((r) => r.edit === edit)) return 'refused';
    return 'pending';
  };

  const title = revert
    ? t('journal.revert.title', {
        id: dialog.source.kind === 'revert' ? dialog.source.entryId : 0,
      })
    : stop
      ? t('search.edit.stopped.title', { applied: appliedCount, total: outcome?.total ?? count })
      : t('search.edit.apply.title', { count });

  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) closeSearchApply();
      }}
      title={title}
      description={
        stop
          ? undefined
          : t(revert ? 'search.edit.revert.description' : 'search.edit.apply.description', {
              count,
            })
      }
      notice={
        prod ? (
          <span className={styles.prod} role="note">
            <Icon name="shield" />
            {t('search.edit.apply.prod')}
          </span>
        ) : undefined
      }
      footer={
        <>
          <Button variant="ghost" onClick={closeSearchApply}>
            {stop ? t('common.close') : t('common.cancel')}
          </Button>
          {conflict && !revert && (
            <Button
              variant="secondary"
              onClick={() => {
                void takeTheirs();
              }}
            >
              <Icon name="undo" />
              {t('search.edit.conflict.theirs')}
            </Button>
          )}
          {conflict && !revert && conflict.kind === 'changed' && conflict.current?.found && (
            <Button
              variant={prod ? 'danger' : 'primary'}
              onClick={() => {
                void keepMine();
              }}
            >
              <Icon name="check" />
              {t('search.edit.conflict.mine')}
            </Button>
          )}
          {!stop && (
            <Button
              variant={prod ? 'danger' : 'primary'}
              disabled={dialog.status !== 'ready' || refused.length > 0}
              onClick={() => {
                void applySearchDialog();
              }}
            >
              {dialog.status === 'applying' ? (
                <Spinner />
              ) : (
                <Icon name={revert ? 'undo' : 'check'} />
              )}
              {revert
                ? t('journal.revert.apply', { count })
                : t('search.edit.apply.button', { count })}
            </Button>
          )}
        </>
      }
    >
      <div className={styles.body} data-testid="search-apply-dialog">
        {connection && <ConnectionBanner connection={connection} />}
        {dialog.status === 'loading' && (
          <div className={styles.loading}>
            <Spinner />
            {t('search.edit.apply.loading')}
          </div>
        )}
        {dialog.error && (
          <p className={styles.error} role="alert">
            {localize(dialog.error.message)}
          </p>
        )}
        {count > 1 && !stop && (
          <p className={styles.notice} role="note" data-testid="search-not-atomic">
            <Icon name="warning" className={styles.noticeIcon} />
            {t('search.edit.apply.notAtomic', { count })}
          </p>
        )}
        {stop && (
          <p className={styles.notice} role="alert" data-testid="search-stopped">
            <Icon name="warning" className={styles.noticeIcon} />
            {conflict
              ? t(`search.edit.conflict.${conflict.kind}`, {
                  number: stop.edit + 1,
                })
              : t('search.edit.stopped.failed', { number: stop.edit + 1 })}{' '}
            {appliedCount > 0 &&
              (outcome?.revertible
                ? t('search.edit.stopped.journaled', { id: outcome.journalId ?? 0 })
                : t('search.edit.stopped.notRevertible'))}
          </p>
        )}
        {stop?.reason.kind === 'failed' && (
          <p className={styles.error} role="alert">
            {localize(stop.reason.error.message)}
            {stop.reason.error.detail && ` (${stop.reason.error.detail})`}
          </p>
        )}
        {conflict && (
          <div className={styles.versions} data-testid="search-conflict">
            <section className={styles.version} data-kind="mine">
              <span className={styles.versionTitle}>
                {revert ? t('search.edit.conflict.revertVersion') : t('search.edit.conflict.yours')}
              </span>
              <pre className={styles.versionText}>
                {editSource(stoppedEdit) ?? t('search.edit.conflict.deleted')}
              </pre>
            </section>
            <section className={styles.version} data-kind="theirs">
              <span className={styles.versionTitle}>
                {conflict.current?.guard
                  ? t('search.edit.conflict.serverAt', conflict.current.guard)
                  : t('search.edit.conflict.server')}
              </span>
              <pre className={styles.versionText}>
                {conflict.current?.found
                  ? (conflict.current.source ?? '')
                  : t('search.edit.conflict.gone')}
              </pre>
            </section>
          </div>
        )}
        {preview && (
          <ol className={styles.requests} aria-label={t('search.edit.apply.requests')}>
            {preview.requests.map((request) => {
              const state = stateOf(request.edit);
              const edit = changes.edits[request.edit];
              const said = edit ? describe(edit) : null;
              const reason = refused.find((r) => r.edit === request.edit)?.reason;
              const why = reason ? blockText(reason) : null;
              return (
                <li key={request.edit}>
                  <pre className={styles.request} data-state={state}>
                    <span className={styles.requestNote}>
                      {said && t(said.key, said.params)}
                      {state === 'applied' && ` · ${t('search.edit.apply.done')}`}
                      {state === 'stopped' && ` · ${t('search.edit.apply.stoppedHere')}`}
                      {why && ` · ${t(why.key, why.params)}`}
                    </span>
                    {request.text}
                  </pre>
                </li>
              );
            })}
          </ol>
        )}
        <p className={styles.hint}>{t('search.edit.apply.outOfScope')}</p>
      </div>
    </Dialog>
  );
}
