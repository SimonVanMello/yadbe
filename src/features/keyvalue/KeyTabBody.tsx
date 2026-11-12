import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import type { ShellTab } from '../../app/tabs/tabsStore';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, YadbeIpcError, type KvBytes } from '../../ipc';
import { Spinner } from '../../ui/Spinner';
import { ToolTabGuard } from '../tools/ToolTabGuard';
import { CollectionViewer } from './CollectionViewer';
import { JsonDocumentViewer } from './JsonDocumentViewer';
import { KeyEditBar } from './KeyEditBar';
import { KeyHeader } from './KeyHeader';
import styles from './KeyTab.module.css';
import { bytesId } from './kvBytes';
import { initTabEdits, rereadTab } from './kvEditActions';
import { useTabRound } from './kvEditStore';
import { StringViewer } from './StringViewer';

interface KeyTabBodyProps {
  tab: ShellTab;
  target: { database: number; key: KvBytes };
}

/**
 * Body of a key tab: the key's header (type, time to live, encoding, memory, length and the
 * key-level actions), the pending changes, and the viewer of its type, where its content is
 * edited (M4-6). Needs the connection to be open.
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
        <KeyView
          tabId={tab.id}
          connectionId={connection.id}
          readOnly={connection.readOnly}
          database={target.database}
          keyBytes={target.key}
        />
      )}
    </ToolTabGuard>
  );
}

function KeyView({
  tabId,
  connectionId,
  readOnly,
  database,
  keyBytes,
}: {
  tabId: string;
  connectionId: string;
  readOnly: boolean;
  database: number;
  keyBytes: KvBytes;
}) {
  const t = useT();
  useEffect(() => {
    initTabEdits(tabId, connectionId, database, keyBytes);
  }, [tabId, connectionId, database, keyBytes]);
  // Moved by "Refresh" and by each apply: the viewer reads the key again from the start.
  const round = useTabRound(tabId);
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
    rereadTab(tabId);
  };
  const viewerKey = `${bytesId(keyBytes)}:${String(round)}`;
  const editable = !readOnly && data.kind !== 'missing' && data.kind !== 'unknown';
  return (
    <div className={styles.tab} data-kind={data.kind}>
      <KeyHeader
        tabId={tabId}
        connectionId={connectionId}
        info={data}
        readOnly={readOnly}
        refreshing={info.isFetching}
        onRefresh={refresh}
      />
      {data.kind !== 'missing' && <KeyEditBar tabId={tabId} readOnly={readOnly} />}
      <div className={styles.viewer}>
        {(() => {
          switch (data.kind) {
            case 'string':
              return (
                <StringViewer
                  key={viewerKey}
                  tabId={tabId}
                  editable={editable}
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
                  tabId={tabId}
                  editable={editable}
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
                  tabId={tabId}
                  editable={editable}
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
