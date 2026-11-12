import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import type { ShellTab } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, YadbeIpcError, type KvBytes } from '../../ipc';
import { Spinner } from '../../ui/Spinner';
import { ToolTabGuard } from '../tools/ToolTabGuard';
import { CollectionViewer } from './CollectionViewer';
import { JsonDocumentViewer } from './JsonDocumentViewer';
import { KeyHeader } from './KeyHeader';
import styles from './KeyTab.module.css';
import { bytesId } from './kvBytes';
import { StringViewer } from './StringViewer';

interface KeyTabBodyProps {
  tab: ShellTab;
  target: { database: number; key: KvBytes };
}

/**
 * Body of a key tab: the key's header (type, time to live, encoding, memory, length) and the
 * viewer of its type. Read-only (editing is M4-6). Needs the connection to be open.
 */
export function KeyTabBody({ tab, target }: KeyTabBodyProps) {
  const t = useT();
  return (
    <ToolTabGuard
      tab={tab}
      title={target.key.text}
      needsConnection={t('keyValue.tab.needsConnection')}
    >
      {(connection) => (
        <KeyView connectionId={connection.id} database={target.database} keyBytes={target.key} />
      )}
    </ToolTabGuard>
  );
}

function KeyView({
  connectionId,
  database,
  keyBytes,
}: {
  connectionId: string;
  database: number;
  keyBytes: KvBytes;
}) {
  const t = useT();
  // Bumped by "Refresh": the viewer reads the key again from the start.
  const [round, setRound] = useState(0);
  const info = useQuery({
    queryKey: ['kvKeyInfo', connectionId, database, bytesId(keyBytes), round],
    queryFn: () => unwrap(ipc.commands.kvKeyInfo(connectionId, database, keyBytes)),
    staleTime: Infinity,
    gcTime: 0,
  });

  if (info.isPending) {
    return (
      <div className={styles.center}>
        <Spinner />
      </div>
    );
  }
  if (info.isError) {
    const error = info.error instanceof YadbeIpcError ? info.error.error : null;
    return (
      <div className={styles.center}>
        {error && <ErrorPanel title={t('keyValue.tab.readFailed')} error={error} />}
      </div>
    );
  }
  const data = info.data;
  const refresh = () => {
    setRound((n) => n + 1);
  };
  const viewerKey = `${bytesId(keyBytes)}:${String(round)}`;
  return (
    <div className={styles.tab} data-kind={data.kind}>
      <KeyHeader info={data} refreshing={info.isFetching} onRefresh={refresh} />
      <div className={styles.viewer}>
        {(() => {
          switch (data.kind) {
            case 'string':
              return (
                <StringViewer
                  key={viewerKey}
                  connectionId={connectionId}
                  database={database}
                  keyBytes={keyBytes}
                />
              );
            case 'hash':
            case 'list':
            case 'set':
            case 'zset':
            case 'stream':
              return (
                <CollectionViewer
                  key={viewerKey}
                  connectionId={connectionId}
                  database={database}
                  keyBytes={keyBytes}
                  kind={data.kind}
                />
              );
            case 'json':
              return (
                <JsonDocumentViewer
                  key={viewerKey}
                  connectionId={connectionId}
                  database={database}
                  keyBytes={keyBytes}
                />
              );
            case 'unknown':
              return (
                <p className={styles.note}>
                  {t('keyValue.tab.unknownType', { type: data.typeName })}
                </p>
              );
            case 'missing':
              return <p className={styles.note}>{t('keyValue.tab.missing')}</p>;
          }
        })()}
      </div>
    </div>
  );
}
