import { useState } from 'react';

import { showError } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { ipc, unwrap } from '../../ipc';
import { fileDialog } from '../../ipc/fileDialog';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { toast } from '../../ui/toastStore';
import { EngineBadge } from './EngineBadge';
import styles from './ConnectionImportDialog.module.css';
import { useConnections } from './connectionStore';
import { useConnectionTransfer } from './connectionTransferStore';

/** Mounted once in the shell: opens from the sidebar menu and the palette. */
export function ConnectionExportDialog() {
  const open = useConnectionTransfer((state) => state.exporting);
  const close = useConnectionTransfer((state) => state.closeExport);
  return open && <ExportForm onClose={close} />;
}

function ExportForm({ onClose }: { onClose: () => void }) {
  const t = useT();
  const connections = useConnections();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(connections.map((c) => c.id)),
  );
  const [working, setWorking] = useState(false);
  const allSelected = connections.length > 0 && connections.every((c) => selected.has(c.id));

  const start = async () => {
    const ids = connections.filter((c) => selected.has(c.id)).map((c) => c.id);
    const path = await fileDialog.pickJsonSavePath(
      {
        title: t('connExport.saveTitle'),
        jsonFiles: t('connExport.filter'),
        allFiles: t('export.filter.all'),
      },
      'yadbe-connections.json',
    );
    if (path === null) return;
    setWorking(true);
    try {
      const count = await unwrap(ipc.commands.exportConnections(path, ids));
      toast({
        variant: 'success',
        title: t('connExport.done', { count }),
        description: path,
        duration: 8000,
      });
      onClose();
    } catch (error) {
      setWorking(false);
      showError(error, { title: t('connExport.failed') });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !working) onClose();
      }}
      wide
      title={t('connExport.title')}
      description={t('connExport.description')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={working}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={selected.size === 0 || working}
            onClick={() => {
              void start();
            }}
          >
            {t('connExport.start', { count: selected.size })}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        {connections.length === 0 ? (
          <p className={styles.muted}>{t('connExport.empty')}</p>
        ) : (
          <>
            <div className={styles.listHead}>
              <span className={styles.sectionTitle}>{t('connImport.found')}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSelected(allSelected ? new Set() : new Set(connections.map((c) => c.id)));
                }}
              >
                {allSelected ? t('connImport.selectNone') : t('connImport.selectAll')}
              </Button>
            </div>
            <div className={styles.list} role="group" aria-label={t('connImport.found')}>
              {connections.map((connection) => (
                <div key={connection.id} className={styles.row}>
                  <input
                    id={`export-${connection.id}`}
                    type="checkbox"
                    className={styles.check}
                    checked={selected.has(connection.id)}
                    onChange={() => {
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(connection.id)) next.delete(connection.id);
                        else next.add(connection.id);
                        return next;
                      });
                    }}
                  />
                  <label htmlFor={`export-${connection.id}`} className={styles.rowBody}>
                    <span className={styles.rowTitle}>
                      <EngineBadge engine={connection.engine} />
                      <span className={styles.name}>{connection.name}</span>
                    </span>
                    <span className={styles.target}>{connection.target}</span>
                  </label>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
