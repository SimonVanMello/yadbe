import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { useT } from '../../i18n/useT';
import { ipc, unwrap, YadbeIpcError, type KvBytes } from '../../ipc';
import { Spinner } from '../../ui/Spinner';
import { JsonView } from '../grid/JsonView';
import { tryParseJson } from '../grid/jsonTree';
import styles from './KeyTab.module.css';
import { bytesId } from './kvBytes';

/** A RedisJSON document (`JSON.GET`), in the grid's JSON tree (numbers kept exact). */
export function JsonDocumentViewer({
  connectionId,
  database,
  keyBytes,
}: {
  connectionId: string;
  database: number;
  keyBytes: KvBytes;
}) {
  const t = useT();
  const doc = useQuery({
    queryKey: ['kvJson', connectionId, database, bytesId(keyBytes)],
    queryFn: () => unwrap(ipc.commands.kvReadJson(connectionId, database, keyBytes)),
    staleTime: Infinity,
    gcTime: 0,
  });
  const tree = useMemo(() => (doc.data === undefined ? null : tryParseJson(doc.data)), [doc.data]);

  if (doc.isPending) {
    return (
      <div className={styles.center}>
        <Spinner />
      </div>
    );
  }
  if (doc.isError) {
    return (
      <div className={styles.center}>
        {doc.error instanceof YadbeIpcError && (
          <ErrorPanel title={t('keyValue.tab.readFailed')} error={doc.error.error} />
        )}
      </div>
    );
  }
  return tree === null ? (
    <pre className={styles.content}>{doc.data}</pre>
  ) : (
    <div className={styles.json} data-testid="kv-json">
      <JsonView tree={tree} openness="auto" />
    </div>
  );
}
