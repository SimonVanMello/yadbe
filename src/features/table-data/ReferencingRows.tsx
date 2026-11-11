import { useEffect, useState } from 'react';

import { localize } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import {
  ipc,
  type BoundedCount,
  type IncomingForeignKey,
  type KeyValue,
  type YadbeError,
} from '../../ipc';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { describeKey } from './fkModel';
import {
  focusedCell,
  newRequestId,
  openReferencing,
  referencingKeyOf,
  rowValues,
} from './fkNavigation';
import styles from './ForeignKeys.module.css';
import { tableSource, tableTabOf } from './tableActions';
import { tableLabel } from './tableNames';
import { getTableSession } from './tableSessionStore';

/** Counts stop there ("1 000+"): exact below, never an estimate. */
export const REFERENCING_COUNT_LIMIT = 1000;

interface Item {
  incoming: IncomingForeignKey;
  /** `null`: this row's referenced value is NULL, so nothing references it this way. */
  key: KeyValue[] | null;
  count: BoundedCount | 'pending' | 'failed' | null;
}

type PanelState =
  | { status: 'loading' }
  | { status: 'noRow' | 'newRow' }
  | { status: 'failed'; error: YadbeError }
  | { status: 'ready'; supported: boolean; row: string; items: Item[] };

/**
 * The rows that reference the focused row (F-088): one entry per foreign key of another (or
 * the same) table that targets this one, with how many rows hold this row's key there,
 * counted lazily one after the other, each cancelled when the panel closes. Choosing one opens
 * that table filtered on them.
 */
export function ReferencingRows({ tabId }: { tabId: string }) {
  const t = useT();
  const [state, setState] = useState<PanelState>({ status: 'loading' });

  useEffect(() => {
    // Read through a call: the cleanup's change is seen after each `await`.
    const alive = { current: true };
    const stopped = () => !alive.current;
    const requests: string[] = [];
    const setCount = (index: number, count: Item['count']) => {
      setState((current) =>
        current.status === 'ready'
          ? {
              ...current,
              items: current.items.map((item, i) => (i === index ? { ...item, count } : item)),
            }
          : current,
      );
    };
    void (async () => {
      const cell = focusedCell(tabId);
      const tab = tableTabOf(tabId);
      const { info } = getTableSession(tabId);
      const source = tableSource(tabId);
      if (!cell || !tab || !info || !source) {
        setState({ status: 'noRow' });
        return;
      }
      if (source.rowKind(cell.row).kind === 'insert') {
        setState({ status: 'newRow' });
        return;
      }
      const requestId = newRequestId('incoming');
      requests.push(requestId);
      const result = await ipc.commands.getIncomingForeignKeys(
        requestId,
        tab.connectionId,
        info.table,
      );
      if (stopped()) return;
      if (result.status === 'error') {
        setState({ status: 'failed', error: result.error });
        return;
      }
      const identity = info.rowIdentity ?? [];
      const values = identity.length > 0 ? await rowValues(tabId, cell.row, identity) : null;
      const row = values
        ? describeKey(
            identity.map((column) => ({ column, value: values.get(column) ?? { kind: 'null' } })),
          )
        : t('tableData.fk.referencing.rowNumber', { row: cell.row + 1 });
      const items: Item[] = await Promise.all(
        result.data.keys.map(async (incoming) => ({
          incoming,
          key: await referencingKeyOf(tabId, cell.row, incoming),
          count: null,
        })),
      );
      if (stopped()) return;
      setState({ status: 'ready', supported: result.data.supported, row, items });
      for (const [index, item] of items.entries()) {
        if (!item.key) continue;
        setCount(index, 'pending');
        const id = newRequestId('count');
        requests.push(id);
        const counted = await ipc.commands.countReferencingRows(
          tabId,
          id,
          item.incoming.table,
          item.key,
          REFERENCING_COUNT_LIMIT,
        );
        if (stopped()) return;
        setCount(index, counted.status === 'ok' ? counted.data : 'failed');
      }
    })();
    return () => {
      alive.current = false;
      for (const id of requests) void ipc.commands.cancelReferenceLookup(id);
    };
  }, [tabId, t]);

  const title =
    state.status === 'ready'
      ? t('tableData.fk.referencing.title', { row: state.row })
      : t('tableData.fk.referencing.button');

  return (
    <>
      <div className={styles.header}>
        <div className={styles.title}>
          <Icon name="link" className={styles.titleIcon} />
          <span title={title}>{title}</span>
        </div>
      </div>
      <div className={styles.body}>
        {state.status === 'loading' && (
          <div className={styles.state} role="status">
            <Spinner />
            {t('tableData.fk.referencing.loading')}
          </div>
        )}
        {state.status === 'noRow' && (
          <div className={styles.state}>{t('tableData.fk.referencing.noRow')}</div>
        )}
        {state.status === 'newRow' && (
          <div className={styles.state}>{t('tableData.fk.referencing.newRow')}</div>
        )}
        {state.status === 'failed' && (
          <div className={`${styles.state} ${styles.error}`} role="alert">
            <Icon name="error" />
            <span>{localize(state.error.message)}</span>
          </div>
        )}
        {state.status === 'ready' && !state.supported && (
          <div className={styles.state}>{t('tableData.fk.referencing.unsupported')}</div>
        )}
        {state.status === 'ready' && state.supported && state.items.length === 0 && (
          <div className={styles.state}>{t('tableData.fk.referencing.none')}</div>
        )}
        {state.status === 'ready' && state.items.length > 0 && (
          <ul className={styles.list} aria-label={title} data-testid="fk-referencing">
            {state.items.map((item) => {
              const { incoming, key } = item;
              const via = t('tableData.fk.referencing.via', {
                columns: incoming.foreignKey.columns.join(', '),
              });
              return (
                <li key={`${tableLabel(incoming.table)}:${incoming.foreignKey.columns.join(',')}`}>
                  <button
                    type="button"
                    className={styles.item}
                    disabled={!key}
                    onClick={() => {
                      if (key) void openReferencing(tabId, incoming, key);
                    }}
                  >
                    <span className={styles.itemText}>
                      <span className={styles.itemTable}>{tableLabel(incoming.table)}</span>
                      <span className={styles.itemVia}>{via}</span>
                    </span>
                    <CountBadge count={item.count} hasKey={key !== null} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

function CountBadge({ count, hasKey }: { count: Item['count']; hasKey: boolean }) {
  const t = useT();
  if (!hasKey) {
    return (
      <span className={styles.count} data-zero="">
        {t('tableData.fk.referencing.nullKey')}
      </span>
    );
  }
  if (count === null || count === 'pending') {
    return (
      <span className={styles.count} aria-label={t('tableData.fk.counting')}>
        <Spinner />
      </span>
    );
  }
  if (count === 'failed') {
    return <span className={styles.count}>{t('tableData.fk.countFailed')}</span>;
  }
  return (
    <span className={styles.count} data-zero={count.count === 0 || undefined}>
      {count.more
        ? t('tableData.fk.countMore', { count: count.count })
        : t('tableData.fk.count', { count: count.count })}
    </span>
  );
}
