import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { showError } from '../../app/errors/presentError';
import { type MessageKey } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import {
  ipc,
  unwrap,
  YadbeIpcError,
  type ConnectionScan,
  type ConnectionSourceInfo,
  type ConnectionSourceKind,
  type FoundConnection,
  type YadbeError,
} from '../../ipc';
import { importDialog } from '../../ipc/importDialog';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { Spinner } from '../../ui/Spinner';
import { Switch } from '../../ui/Switch';
import { toast } from '../../ui/toastStore';
import { EngineBadge } from './EngineBadge';
import styles from './ConnectionImportDialog.module.css';
import { refreshConnections } from './connectionStore';
import {
  defaultSelection,
  describeTarget,
  folderLabel,
  passwordsAvailable,
  selectedKeys,
} from './connectionImportModel';
import { useConnectionTransfer } from './connectionTransferStore';

const ROW_ESTIMATE = 64;

/** Mounted once in the shell: opens from the sidebar menu and the palette. */
export function ConnectionImportDialog() {
  const open = useConnectionTransfer((state) => state.importing);
  const close = useConnectionTransfer((state) => state.closeImport);
  return open && <ImportForm onClose={close} />;
}

function errorOf(error: unknown): YadbeError | null {
  return error instanceof YadbeIpcError ? error.error : null;
}

function FoundRow({
  found,
  checked,
  onToggle,
}: {
  found: FoundConnection;
  checked: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const id = `found-${found.key}`;
  return (
    <div className={styles.row} data-conflict={found.conflict !== null || undefined}>
      <input
        id={id}
        type="checkbox"
        className={styles.check}
        checked={checked}
        onChange={onToggle}
      />
      <label htmlFor={id} className={styles.rowBody}>
        <span className={styles.rowTitle}>
          <EngineBadge engine={found.definition.engine} />
          <span className={styles.name}>{found.definition.name}</span>
          {found.groupPath.length > 0 && (
            <span className={styles.folder}>{folderLabel(found.groupPath)}</span>
          )}
          {found.hasPassword && <span className={styles.tag}>{t('connImport.hasPassword')}</span>}
        </span>
        <span className={styles.target}>{describeTarget(found)}</span>
        {found.conflict && (
          <span className={styles.warn}>
            {t(`connImport.conflict.${found.conflict.kind}` as MessageKey, {
              name: found.conflict.existingName,
            })}
            . {t('connImport.conflict.hint')}
          </span>
        )}
        {found.notes.map((note) => (
          <span key={note.kind} className={styles.note}>
            {t(`connImport.note.${note.kind}` as MessageKey)}
          </span>
        ))}
      </label>
    </div>
  );
}

function ImportForm({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [sources, setSources] = useState<ConnectionSourceInfo[]>([]);
  const [kind, setKind] = useState<ConnectionSourceKind | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [scan, setScan] = useState<ConnectionScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<YadbeError | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [withPasswords, setWithPasswords] = useState(false);
  const [importing, setImporting] = useState(false);
  const seq = useRef(0);

  const read = (source: ConnectionSourceKind, file: string | null) => {
    const mine = ++seq.current;
    setScanning(true);
    setError(null);
    setScan(null);
    unwrap(ipc.commands.scanConnectionSource(source, file)).then(
      (result) => {
        if (mine !== seq.current) return;
        setScan(result);
        setSelected(defaultSelection(result.connections));
        setScanning(false);
      },
      (failure: unknown) => {
        if (mine !== seq.current) return;
        setError(errorOf(failure));
        setScanning(false);
      },
    );
  };

  // The sources, then the first one found on this computer.
  useEffect(() => {
    let current = true;
    unwrap(ipc.commands.listConnectionSources()).then(
      (listed) => {
        if (!current) return;
        setSources(listed);
        const first = listed.find((s) => s.defaultPath !== null) ?? listed[0];
        if (first) {
          setKind(first.kind);
          if (first.defaultPath !== null) read(first.kind, null);
        }
      },
      (failure: unknown) => {
        if (current) setError(errorOf(failure));
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const source = sources.find((s) => s.kind === kind) ?? null;
  const found = useMemo(() => scan?.connections ?? [], [scan]);
  const keys = selectedKeys(found, selected);
  const canPasswords = source?.supportsPasswords === true && passwordsAvailable(found, selected);

  const changeSource = (next: ConnectionSourceKind) => {
    const info = sources.find((s) => s.kind === next);
    seq.current++;
    setKind(next);
    setPath(null);
    setScan(null);
    setError(null);
    setScanning(false);
    if (info?.defaultPath) read(next, null);
  };

  const chooseFile = async () => {
    if (!kind) return;
    const picked = await importDialog.pickConnectionsFile({
      title: t('connImport.pick.title'),
      filterName: t('connImport.pick.filter'),
      allFiles: t('export.filter.all'),
      extensions:
        kind === 'yadbe' ||
        kind === 'azureDataStudio' ||
        kind === 'vscodeMssql' ||
        kind === 'dbeaver'
          ? ['json']
          : ['*'],
    });
    if (picked === null) return;
    setPath(picked);
    read(kind, picked);
  };

  const start = () => {
    if (!kind || keys.length === 0) return;
    setImporting(true);
    unwrap(
      ipc.commands.importConnections({
        kind,
        path,
        keys,
        importPasswords: withPasswords && canPasswords,
      }),
    ).then(
      (result) => {
        void refreshConnections();
        const detail = [
          t('connImport.done.detail', {
            groups: result.groupsCreated,
            stored: result.passwordsStored,
            session: result.passwordsSessionOnly,
          }),
          ...result.failed.map((f) =>
            t('connImport.itemFailed', { name: f.name, detail: f.detail }),
          ),
        ].join('\n');
        toast({
          variant: result.failed.length > 0 ? 'warning' : 'success',
          title: t('connImport.done', { count: result.created.length }),
          description: detail,
          duration: 8000,
        });
        onClose();
      },
      (failure: unknown) => {
        setImporting(false);
        showError(failure, { title: t('connImport.importFailed') });
      },
    );
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- rows are plain props, nothing memoized reads the virtualizer
  const virtualizer = useVirtualizer({
    count: found.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 8,
  });
  const allSelected = useMemo(
    () => found.length > 0 && found.every((c) => selected.has(c.key)),
    [found, selected],
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !importing) onClose();
      }}
      wide
      title={t('connImport.title')}
      description={t('connImport.description')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={importing}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={keys.length === 0 || importing} onClick={start}>
            {t('connImport.start', { count: keys.length })}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <Field label={t('connImport.source')} htmlFor="connimport-source">
          <Select<ConnectionSourceKind>
            id="connimport-source"
            value={kind ?? 'azureDataStudio'}
            options={sources.map((s) => ({
              value: s.kind,
              label: t(`connImport.source.${s.kind}` as MessageKey),
            }))}
            onChange={changeSource}
          />
        </Field>
        <div className={styles.fileRow}>
          <span className={styles.filePath} data-testid="connimport-file">
            {path !== null
              ? t('connImport.file.chosen', { path })
              : source?.defaultPath
                ? t('connImport.file.found', { path: source.defaultPath })
                : t('connImport.file.notFound')}
          </span>
          <Button
            onClick={() => {
              void chooseFile();
            }}
          >
            {t('connImport.file.choose')}
          </Button>
        </div>

        {scanning && (
          <p className={styles.muted}>
            <Spinner /> {t('connImport.file.read')}…
          </p>
        )}
        {error && <ErrorPanel title={t('connImport.failed')} error={error} compact />}

        {scan && (
          <>
            <div className={styles.listHead}>
              <span className={styles.sectionTitle}>
                {t('connImport.found')} ({found.length})
              </span>
              {found.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSelected(allSelected ? new Set() : new Set(found.map((c) => c.key)));
                  }}
                >
                  {allSelected ? t('connImport.selectNone') : t('connImport.selectAll')}
                </Button>
              )}
            </div>
            {found.length === 0 ? (
              <p className={styles.muted}>{t('connImport.none')}</p>
            ) : (
              <div
                ref={scrollRef}
                className={styles.list}
                role="group"
                aria-label={t('connImport.found')}
              >
                <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                  {virtualizer.getVirtualItems().map((item) => {
                    const row = found[item.index];
                    if (!row) return null;
                    return (
                      <div
                        key={row.key}
                        data-index={item.index}
                        ref={virtualizer.measureElement}
                        className={styles.virtualRow}
                        style={{ transform: `translateY(${String(item.start)}px)` }}
                      >
                        <FoundRow
                          found={row}
                          checked={selected.has(row.key)}
                          onToggle={() => {
                            setSelected((current) => {
                              const next = new Set(current);
                              if (next.has(row.key)) next.delete(row.key);
                              else next.add(row.key);
                              return next;
                            });
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {scan.skipped.length > 0 && (
              <div className={styles.skipped}>
                <span className={styles.sectionTitle}>{t('connImport.skipped')}</span>
                <ul>
                  {scan.skipped.map((skip) => (
                    <li key={`${skip.name}:${skip.reason}`}>
                      {t(`connImport.skip.${skip.reason}` as MessageKey, {
                        name: skip.name,
                        detail: skip.detail ?? '',
                      })}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {source?.supportsPasswords && (
              <Switch
                label={t('connImport.passwords')}
                hint={t('connImport.passwordsHint')}
                checked={withPasswords && canPasswords}
                disabled={!canPasswords}
                onCheckedChange={setWithPasswords}
              />
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
