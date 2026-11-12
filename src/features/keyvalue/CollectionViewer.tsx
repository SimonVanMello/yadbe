import { useEffect, useMemo, useState } from 'react';

import { ErrorPanel } from '../../app/errors/ErrorPanel';
import { formatNumber, useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import {
  ipc,
  unwrap,
  YadbeIpcError,
  type KvBytes,
  type KvCollection,
  type KvKeyKind,
  type YadbeError,
} from '../../ipc';
import { Button } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';
import { DataGrid } from '../grid/DataGrid';
import { createResultRowSource, type ResultRowSource } from '../grid/resultRowSource';
import styles from './KeyTab.module.css';

/** Rows read when a collection opens, and by each "load more". */
export const COLLECTION_PAGE = 1000;

/**
 * A hash, list, set, sorted set or stream in the data grid. The backend reads it a page at a
 * time (`HSCAN`, `LRANGE`, `SSCAN`, `ZRANGE`, `XRANGE`) into the result store and the grid reads
 * windows of it (rule 8): a collection of millions of elements is never in the frontend.
 */
export function CollectionViewer({
  connectionId,
  database,
  keyBytes,
  kind,
}: {
  connectionId: string;
  database: number;
  keyBytes: KvBytes;
  kind: KvKeyKind;
}) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const [collection, setCollection] = useState<KvCollection | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<YadbeError | null>(null);

  useEffect(() => {
    let alive = true;
    let opened: number | null = null;
    unwrap(ipc.commands.kvOpenCollection(connectionId, database, keyBytes, COLLECTION_PAGE))
      .then((first) => {
        opened = first.resultId;
        if (alive) setCollection(first);
        else void ipc.commands.kvCloseCollection(first.resultId);
      })
      .catch((caught: unknown) => {
        if (alive && caught instanceof YadbeIpcError) setError(caught.error);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
      if (opened !== null) void ipc.commands.kvCloseCollection(opened);
    };
  }, [connectionId, database, keyBytes]);

  const source: ResultRowSource | null = useMemo(
    () =>
      collection
        ? createResultRowSource(collection.resultId, collection.columns, collection.rowCount)
        : null,
    // One source per opened collection; more rows only move its row count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collection?.resultId],
  );

  useEffect(() => {
    if (!source) return;
    source.revive();
    return () => {
      source.dispose();
    };
  }, [source]);

  const more = (rows: number | null) => {
    if (!collection) return;
    setBusy(true);
    unwrap(ipc.commands.kvCollectionMore(collection.resultId, rows))
      .then((next) => {
        source?.setRowCount(next.rowCount);
        setCollection(next);
      })
      .catch((caught: unknown) => {
        if (caught instanceof YadbeIpcError) setError(caught.error);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (error && !collection) {
    return (
      <div className={styles.center}>
        <ErrorPanel title={t('keyValue.tab.readFailed')} error={error} />
      </div>
    );
  }
  if (!collection || !source) {
    return (
      <div className={styles.center}>
        <Spinner />
      </div>
    );
  }

  const count = formatNumber(locale, collection.rowCount);
  const total = collection.total === null ? null : formatNumber(locale, collection.total);
  const footer = (
    <span className={styles.footerNote}>
      {collection.done || total === null
        ? t('keyValue.collection.read', { count })
        : t('keyValue.collection.partial', { count, total })}
      {!collection.done && (
        <>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              more(COLLECTION_PAGE);
            }}
          >
            {t('keyValue.collection.more', { count: formatNumber(locale, COLLECTION_PAGE) })}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              more(null);
            }}
          >
            {t('keyValue.collection.all')}
          </Button>
        </>
      )}
      {busy && <Spinner />}
    </span>
  );

  return (
    <div className={styles.grid} data-collection={kind}>
      {error && <ErrorPanel compact title={t('keyValue.tab.readFailed')} error={error} />}
      <DataGrid
        source={source}
        sourceKey={`kv-${String(collection.resultId)}`}
        label={keyBytes.text}
        footer={footer}
        emptyText={t('keyValue.collection.empty')}
        readOnly
      />
    </div>
  );
}
