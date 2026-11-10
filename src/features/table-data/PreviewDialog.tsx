import { useEffect } from 'react';

import { shortcutOf } from '../../app/actions';
import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { matchShortcut } from '../../ui/shortcuts';
import { Spinner } from '../../ui/Spinner';
import { Switch } from '../../ui/Switch';
import { ConnectionBanner } from '../connections/ConnectionBanner';
import type { ConnectionSummary } from '../connections/model';
import styles from './PreviewDialog.module.css';
import { SqlView } from './SqlView';
import { applyChanges, closePreview } from './tableActions';
import { useTableSession } from './tableSessionStore';
import { setPreference, usePreference } from '../preferences/preferenceStore';

/**
 * "Preview SQL" (F-085): the transaction Apply would run, as readable SQL, with the connection
 * and its environment. Always shown before applying on a production connection.
 */
export function PreviewDialog({
  tabId,
  connection,
}: {
  tabId: string;
  connection: ConnectionSummary;
}) {
  const t = useT();
  const { preview, applying, info } = useTableSession(tabId);
  const previewFirst = usePreference('previewBeforeApply');
  const prod = connection.environment === 'prod';
  const ready = preview?.status === 'ready' && !applying;
  // The Apply button shows `Mod+S`; global shortcuts are off while a dialog is open, so the
  // dialog listens itself.
  useEffect(() => {
    if (!ready) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchShortcut(event, shortcutOf('table.apply'))) return;
      event.preventDefault();
      void applyChanges(tabId);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [ready, tabId]);
  if (!preview) return null;
  const statements = preview.data?.statements.length ?? 0;

  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => {
        if (!open) closePreview(tabId);
      }}
      title={t('tableData.preview.title')}
      description={
        preview.status === 'ready'
          ? t('tableData.preview.description', { count: statements })
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
          {!prod && (
            <div className={styles.preference}>
              <Switch
                checked={previewFirst}
                onCheckedChange={(checked) => {
                  setPreference('previewBeforeApply', checked);
                }}
                label={t('tableData.preview.always')}
              />
            </div>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              closePreview(tabId);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant={prod ? 'danger' : 'primary'}
            disabled={preview.status !== 'ready' || applying}
            onClick={() => {
              void applyChanges(tabId);
            }}
          >
            {applying ? <Spinner /> : <Icon name="check" />}
            {t('tableData.preview.apply', { count: statements })}
            <Kbd shortcut={shortcutOf('table.apply')} />
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <ConnectionBanner
          connection={{ ...connection, database: info?.table.database ?? connection.database }}
        />
        {preview.status === 'loading' && (
          <div className={styles.loading}>
            <Spinner />
            {t('tableData.preview.loading')}
          </div>
        )}
        {preview.status === 'failed' && preview.error && (
          <p className={styles.error} role="alert">
            {localize(preview.error.message)}
          </p>
        )}
        {preview.data && (
          <SqlView
            sql={preview.data.script}
            engine={connection.engine}
            label={t('tableData.preview.sqlLabel')}
          />
        )}
      </div>
    </Dialog>
  );
}
