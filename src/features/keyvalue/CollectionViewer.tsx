import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

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
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { DataGrid, type GridCellRef } from '../grid/DataGrid';
import { createResultRowSource, type ResultRowSource } from '../grid/resultRowSource';
import { blockKind, valueText } from '../grid/rowSource';
import styles from './KeyTab.module.css';
import { addItem, editRow, removeRow, renameField, type CollectionRow } from './kvEditForms';
import { cellBytes, overlayOf, type CollectionKind } from './kvEditModel';
import { useTabEdits } from './kvEditStore';
import { createOverlaySource, type KvOverlaySource } from './kvOverlaySource';

/** Rows read when a collection opens, and by each "load more". */
export const COLLECTION_PAGE = 1000;

const EDIT_ROW = {
  hash: 'keyValue.collection.editRow.hash',
  list: 'keyValue.collection.editRow.list',
  zset: 'keyValue.collection.editRow.zset',
} as const;

/** Whether a row's values can be edited in place (sets and streams only add and remove). */
function hasValues(kind: CollectionKind): boolean {
  return kind === 'hash' || kind === 'list' || kind === 'zset';
}

/**
 * A hash, list, set, sorted set or stream in the data grid. The backend reads it a page at a
 * time (`HSCAN`, `LRANGE`, `SSCAN`, `ZRANGE`, `XRANGE`) into the result store and the grid reads
 * windows of it (rule 8): a collection of millions of elements is never in the frontend.
 * Editable (M4-6): add, edit, rename (hash fields), remove; the pending edits are drawn over
 * the rows with the table tab's marks (changed, added, removed) until Apply.
 */
export function CollectionViewer({
  tabId,
  editable,
  connectionId,
  database,
  keyBytes,
  kind,
}: {
  tabId: string;
  editable: boolean;
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
  const [focused, setFocused] = useState<GridCellRef | null>(null);
  const edits = useTabEdits(tabId);
  const collectionKind = kind as CollectionKind;

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

  const sources: { base: ResultRowSource; shown: KvOverlaySource } | null = useMemo(() => {
    if (!collection) return null;
    const base = createResultRowSource(
      collection.resultId,
      collection.columns,
      collection.rowCount,
    );
    return { base, shown: createOverlaySource(base, collectionKind) };
    // One source per opened collection; more rows only move its row count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection?.resultId]);

  useEffect(() => {
    if (!sources) return;
    sources.base.revive();
    return () => {
      sources.base.dispose();
    };
  }, [sources]);

  useEffect(() => {
    sources?.shown.setOverlay(overlayOf(edits));
  }, [sources, edits]);

  const more = (rows: number | null) => {
    if (!collection) return;
    setBusy(true);
    unwrap(ipc.commands.kvCollectionMore(collection.resultId, rows))
      .then((next) => {
        sources?.base.setRowCount(next.rowCount);
        setCollection(next);
      })
      .catch((caught: unknown) => {
        if (caught instanceof YadbeIpcError) setError(caught.error);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  /** The server's cells of a row, exact (binary and long values included). */
  const serverRow = async (row: number): Promise<CollectionRow | null> => {
    if (!sources || row >= sources.base.rowCount) return null;
    const [block] = await sources.base.read(row, row + 1);
    if (!block) return null;
    const at = row - block.offset;
    const cells: KvBytes[] = [];
    for (const [col, column] of block.columns.entries()) {
      const kindOf = blockKind(block, at, col, sources.base.columns[col]?.kind ?? 'text');
      const cut = column.truncated.includes(at);
      const text = cut
        ? (valueText(await sources.base.fullValue(row, col)) ?? '')
        : (column.values[at] ?? '');
      cells.push(cellBytes(text, kindOf));
    }
    return { cells };
  };

  const onRow = (action: (row: CollectionRow) => void | Promise<void>) => {
    if (focused === null) return;
    void serverRow(focused.row).then((row) => {
      if (row) void action(row);
    });
  };

  if (error && !collection) {
    return (
      <div className={styles.center}>
        <ErrorPanel title={t('keyValue.tab.readFailed')} error={error} />
      </div>
    );
  }
  if (!collection || !sources) {
    return (
      <div className={styles.center}>
        <Spinner />
      </div>
    );
  }

  const onServerRow = focused !== null && focused.row < sources.base.rowCount;
  const toolbar = editable ? (
    <div className={styles.toolbar} role="toolbar" aria-label={t('keyValue.collection.edit')}>
      <Button
        size="sm"
        onClick={() => {
          void addItem(tabId, collectionKind, keyBytes);
        }}
      >
        <Icon name="plus" />
        {t(`keyValue.collection.add.${collectionKind}`)}
      </Button>
      {hasValues(collectionKind) && (
        <Button
          size="sm"
          disabled={!onServerRow}
          onClick={() => {
            onRow((row) => editRow(tabId, collectionKind, keyBytes, row));
          }}
        >
          <Icon name="pencil" />
          {t(EDIT_ROW[collectionKind as 'hash' | 'list' | 'zset'])}
        </Button>
      )}
      {collectionKind === 'hash' && (
        <Button
          size="sm"
          disabled={!onServerRow}
          onClick={() => {
            onRow((row) => renameField(tabId, keyBytes, row));
          }}
        >
          {t('keyValue.collection.renameField')}
        </Button>
      )}
      <Button
        size="sm"
        disabled={!onServerRow}
        onClick={() => {
          onRow((row) => {
            removeRow(tabId, collectionKind, keyBytes, row);
          });
        }}
      >
        <Icon name="trash" />
        {t('keyValue.collection.remove')}
      </Button>
      <span className={styles.toolbarInfo}>
        {hasValues(collectionKind)
          ? t('keyValue.collection.editHint')
          : t('keyValue.collection.removeHint')}
      </span>
    </div>
  ) : null;

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
        source={sources.shown}
        sourceKey={`kv-${String(collection.resultId)}`}
        label={keyBytes.text}
        footer={footer}
        top={toolbar}
        emptyText={t('keyValue.collection.empty')}
        readOnly={!editable}
        onFocusChange={setFocused}
        {...(editable
          ? {
              editing: {
                onCellDoubleClick: (cell: GridCellRef) => {
                  if (!hasValues(collectionKind) || cell.row >= sources.base.rowCount) return false;
                  void serverRow(cell.row).then((row) => {
                    if (row) void editRow(tabId, collectionKind, keyBytes, row);
                  });
                  return true;
                },
                onKeyDown: (event: ReactKeyboardEvent<HTMLElement>, cell: GridCellRef | null) => {
                  if (event.key !== 'Delete' || cell === null || cell.row >= sources.base.rowCount)
                    return false;
                  void serverRow(cell.row).then((row) => {
                    if (row) removeRow(tabId, collectionKind, keyBytes, row);
                  });
                  return true;
                },
              },
            }
          : {})}
      />
    </div>
  );
}
