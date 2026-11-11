import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { ConnectionBanner } from '../connections/ConnectionBanner';
import type { ConnectionSummary } from '../connections/model';
import styles from './PreviewDialog.module.css';
import revertStyles from './RevertDialog.module.css';
import { SqlView } from './SqlView';
import { applyRevert, closeRevert } from './tableActions';
import { useTableSession } from './tableSessionStore';

/**
 * "Revert this change set" (F-090): the inverse statements as they would run now, reviewed
 * before they run in one transaction. Rows changed since the change set are listed instead of
 * being overwritten.
 */
export function RevertDialog({
  tabId,
  connection,
}: {
  tabId: string;
  connection: ConnectionSummary;
}) {
  const t = useT();
  const { revert, info } = useTableSession(tabId);
  if (!revert) return null;
  const prod = connection.environment === 'prod';
  const count = revert.preview?.statements.length ?? 0;
  const done = revert.status === 'conflicted' || revert.status === 'rolledBack';

  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) closeRevert(tabId);
      }}
      title={t('journal.revert.title', { id: revert.entryId })}
      description={revert.preview ? t('journal.revert.description', { count }) : undefined}
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
          <Button
            variant="ghost"
            onClick={() => {
              closeRevert(tabId);
            }}
          >
            {done ? t('common.close') : t('common.cancel')}
          </Button>
          {!done && (
            <Button
              variant={prod ? 'danger' : 'primary'}
              disabled={revert.status !== 'ready'}
              onClick={() => {
                void applyRevert(tabId);
              }}
            >
              {revert.status === 'applying' ? <Spinner /> : <Icon name="undo" />}
              {t('journal.revert.apply', { count })}
            </Button>
          )}
        </>
      }
    >
      <div className={styles.body} data-testid="revert-dialog">
        <ConnectionBanner
          connection={{ ...connection, database: info?.table.database ?? connection.database }}
        />
        {revert.status === 'loading' && (
          <div className={styles.loading}>
            <Spinner />
            {t('tableData.preview.loading')}
          </div>
        )}
        {revert.status === 'failed' && revert.error && (
          <p className={styles.error} role="alert">
            {localize(revert.error.message)}
          </p>
        )}
        {revert.status === 'conflicted' && (
          <div className={revertStyles.conflicts} role="alert">
            <p className={revertStyles.lead}>
              <Icon name="warning" />
              {t('journal.revert.conflicts', { count: revert.conflicts.length })}
            </p>
            <ul className={revertStyles.list}>
              {revert.conflicts.map((conflict) => (
                <li key={conflict.sql}>
                  <code>{conflict.label}</code>{' '}
                  {conflict.gone ? t('journal.revert.rowGone') : t('journal.revert.rowChanged')}
                </li>
              ))}
            </ul>
          </div>
        )}
        {revert.status === 'rolledBack' && revert.failure && (
          <p className={styles.error} role="alert">
            {localize(revert.failure.error.message)}
          </p>
        )}
        {revert.preview && (
          <SqlView
            sql={revert.preview.script}
            engine={connection.engine}
            label={t('journal.revert.sqlLabel')}
          />
        )}
      </div>
    </Dialog>
  );
}
