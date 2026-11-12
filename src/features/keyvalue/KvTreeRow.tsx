import { memo, useEffect, useState, type CSSProperties, type ReactNode } from 'react';

import { formatNumber, useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { ContextMenu } from '../../ui/ContextMenu';
import { ContextMenuItem } from '../../ui/ContextMenuItem';
import { Icon } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { TextInput } from '../../ui/TextInput';
import { useDebouncedValue } from '../../ui/useDebouncedValue';
import { Highlight } from '../connections/Highlight';
import rowStyles from '../explorer/ExplorerRow.module.css';
import { writeClipboard } from '../grid/clipboard';
import { localize } from '../../app/errors/presentError';
import { rowStyle } from '../sidebar/rowStyle';
import { openKeyTab, rescan, scanMore, setPattern, showMore, stopScan } from './kvActions';
import { kvRowName, type KvRow } from './kvExplorerRows';
import { formatTtl, kindIcon, typeBadge } from './kvFormat';
import { LEVEL_PAGE } from './kvTreeStore';
import { SCAN_MORE } from './kvScanFeed';
import styles from './KvTreeRow.module.css';
import { useKeySummary } from './useKeySummary';

interface KvTreeRowProps {
  row: KvRow;
  id: string;
  index: number;
  active: boolean;
  posInSet: number;
  setSize: number;
  offset: number;
  height: number;
  onSelect: (index: number) => void;
  onToggle: (row: KvRow) => void;
  onOpen: (row: KvRow) => void;
  onRefresh: (row: KvRow) => void;
}

/** The type, time to live and size of a key row, read once the row is on screen. */
function KeySummary({ row }: { row: Extract<KvRow, { type: 'kvKey' }> }) {
  const t = useT();
  const summary = useKeySummary(row.connectionId, row.database, row.fullKey);
  if (!summary.data) return <span className={styles.badge} data-kind="pending" />;
  const { kind, typeName, ttlMs } = summary.data;
  return (
    <>
      {ttlMs !== null && (
        <span className={styles.ttl} title={t('keyValue.tree.ttl')}>
          <Icon name="history" size="sm" />
          {formatTtl(ttlMs, t)}
        </span>
      )}
      <span className={styles.badge} data-kind={kind}>
        {typeBadge(kind, typeName)}
      </span>
    </>
  );
}

function KeyIcon({ row }: { row: Extract<KvRow, { type: 'kvKey' }> }) {
  const summary = useKeySummary(row.connectionId, row.database, row.fullKey);
  return <Icon name={kindIcon(summary.data?.kind ?? null)} className={rowStyles.icon} />;
}

/** The `MATCH` pattern of a database's scan, typed in the tree (it scans again as you type). */
function PatternField({ row }: { row: Extract<KvRow, { type: 'kvPattern' }> }) {
  const t = useT();
  const [text, setText] = useState(row.pattern);
  const debounced = useDebouncedValue(text, 400);
  useEffect(() => {
    if (debounced !== row.pattern) setPattern(row.connectionId, row.database, debounced);
  }, [debounced, row.connectionId, row.database, row.pattern]);
  return (
    <TextInput
      mono
      className={styles.pattern}
      value={text}
      placeholder={t('keyValue.tree.patternPlaceholder')}
      aria-label={t('keyValue.tree.pattern', { database: row.database })}
      onChange={(event) => {
        setText(event.target.value);
      }}
      // The tree's keys (type-ahead, arrows) stay out of the field.
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') setText('');
      }}
      onClick={(event) => {
        event.stopPropagation();
      }}
    />
  );
}

function ScanState({ row }: { row: Extract<KvRow, { type: 'kvScan' }> }) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const { status } = row;
  const loaded = formatNumber(locale, status.loaded);
  const estimate = status.estimate === null ? null : formatNumber(locale, status.estimate);
  const text =
    status.state === 'running'
      ? t('keyValue.scan.running', { loaded, estimate: estimate ?? '?' })
      : status.state === 'failed'
        ? t('keyValue.scan.failed', {
            loaded,
            error: status.error ? localize(status.error.message) : '',
          })
        : t(status.state === 'stopped' ? 'keyValue.scan.stopped' : 'keyValue.scan.paused', {
            loaded,
            estimate: estimate ?? '?',
          });
  const stop = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
  };
  return (
    <>
      {status.state === 'running' && <Spinner />}
      {status.state === 'failed' && <Icon name="warning" className={rowStyles.errorTone} />}
      <span className={rowStyles.statusText} title={text}>
        {text}
      </span>
      {status.state === 'running' ? (
        <Button
          size="sm"
          variant="secondary"
          tabIndex={-1}
          onClick={(event) => {
            stop(event);
            void stopScan(row.connectionId, status.database);
          }}
        >
          {t('keyValue.scan.stop')}
        </Button>
      ) : (
        <>
          <Button
            size="sm"
            variant="secondary"
            tabIndex={-1}
            onClick={(event) => {
              stop(event);
              void scanMore(row.connectionId, status.database, SCAN_MORE);
            }}
          >
            {t('keyValue.scan.more', { count: formatNumber(locale, SCAN_MORE) })}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            tabIndex={-1}
            onClick={(event) => {
              stop(event);
              void scanMore(row.connectionId, status.database, null);
            }}
          >
            {t('keyValue.scan.all')}
          </Button>
        </>
      )}
    </>
  );
}

/** A row of a key-value connection's tree: database, pattern, namespace, key, paging, scan state. */
export const KvTreeRow = memo(function KvTreeRow({
  row,
  id,
  index,
  active,
  posInSet,
  setSize,
  offset,
  height,
  onSelect,
  onToggle,
  onOpen,
  onRefresh,
}: KvTreeRowProps) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const common = {
    id,
    role: 'treeitem',
    'aria-level': row.level,
    'aria-posinset': posInSet,
    'aria-setsize': setSize,
    'aria-selected': active,
    'data-row-index': index,
    'data-active': active || undefined,
    'data-type': row.type,
    style: { ...rowStyle(offset, height), '--depth': row.level - 1 } as CSSProperties,
  };
  const twisty = (
    <span
      className={rowStyles.twisty}
      onClick={(event) => {
        if (!row.expandable) return;
        event.stopPropagation();
        onSelect(index);
        onToggle(row);
      }}
    >
      {row.expandable && <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} />}
    </span>
  );
  const select = () => {
    onSelect(index);
  };

  switch (row.type) {
    case 'kvStatus': {
      const message =
        row.status === 'loading'
          ? t('keyValue.tree.loading')
          : row.status === 'empty'
            ? t(row.subject === 'keys' ? 'keyValue.tree.noKeys' : 'keyValue.tree.noDatabases')
            : row.error
              ? localize(row.error.message)
              : t('keyValue.tree.failed');
      return (
        <div
          {...common}
          aria-label={message}
          data-status={row.status}
          className={rowStyles.row}
          onClick={select}
        >
          <span className={rowStyles.twisty} />
          {row.status === 'loading' && <Spinner />}
          {row.status === 'error' && <Icon name="warning" className={rowStyles.errorTone} />}
          <span className={rowStyles.statusText} title={message}>
            {message}
          </span>
          {row.status === 'error' && (
            <Button
              size="sm"
              variant="secondary"
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                onRefresh(row);
              }}
            >
              {t('explorer.retry')}
            </Button>
          )}
        </div>
      );
    }
    case 'kvScan':
      return (
        <div
          {...common}
          aria-label={t('keyValue.scan.label')}
          data-status={row.status.state}
          className={rowStyles.row}
          onClick={select}
        >
          <span className={rowStyles.twisty} />
          <ScanState row={row} />
        </div>
      );
    case 'kvMore':
      return (
        <div {...common} className={rowStyles.row} onClick={select}>
          <span className={rowStyles.twisty} />
          <Button
            size="sm"
            variant="ghost"
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation();
              showMore(row.connectionId, row.levelNode);
            }}
          >
            {t('keyValue.tree.showMore', {
              count: formatNumber(locale, Math.min(LEVEL_PAGE, row.total - row.shown)),
              total: formatNumber(locale, row.total),
            })}
          </Button>
        </div>
      );
    case 'kvPattern':
      return (
        <div
          {...common}
          aria-label={t('keyValue.tree.pattern', { database: row.database })}
          className={rowStyles.row}
          onClick={select}
        >
          <span className={rowStyles.twisty} />
          <Icon name="filter" className={rowStyles.icon} />
          <PatternField row={row} />
        </div>
      );
    default:
      break;
  }

  let content: ReactNode;
  let menu: ReactNode;
  switch (row.type) {
    case 'kvDatabase': {
      const name = `db${String(row.database.index)}`;
      content = (
        <>
          <Icon name="database" className={rowStyles.icon} />
          <span className={rowStyles.text}>
            <span className={rowStyles.name}>
              <Highlight text={name} indices={row.indices} />
            </span>
            <span className={rowStyles.meta}>
              <span className={rowStyles.count}>
                {t('keyValue.tree.keys', {
                  count: formatNumber(locale, row.database.keys),
                })}
              </span>
            </span>
          </span>
          <button
            type="button"
            tabIndex={-1}
            className={rowStyles.refresh}
            aria-label={t('keyValue.tree.rescan', { database: row.database.index })}
            onClick={(event) => {
              event.stopPropagation();
              void rescan(row.connectionId, row.database.index);
            }}
          >
            <Icon name="retry" />
          </button>
        </>
      );
      menu = (
        <ContextMenuItem
          icon="retry"
          onSelect={() => {
            void rescan(row.connectionId, row.database.index);
          }}
        >
          {t('keyValue.tree.rescan', { database: row.database.index })}
        </ContextMenuItem>
      );
      break;
    }
    case 'kvNamespace':
      content = (
        <>
          <Icon name={row.expanded ? 'folderOpen' : 'folder'} className={rowStyles.icon} />
          <span className={rowStyles.text}>
            <span className={rowStyles.name}>
              <Highlight text={row.name.text} indices={row.indices} />
            </span>
            <span className={rowStyles.meta}>
              <span className={rowStyles.count}>{formatNumber(locale, row.keys)}</span>
            </span>
          </span>
        </>
      );
      menu = (
        <ContextMenuItem
          icon="copy"
          onSelect={() => {
            void writeClipboard(row.prefix.text);
          }}
        >
          {t('keyValue.tree.copyPrefix')}
        </ContextMenuItem>
      );
      break;
    case 'kvKey':
      content = (
        <>
          <KeyIcon row={row} />
          <span className={rowStyles.text}>
            <span className={`${rowStyles.name} ${styles.keyName}`} title={row.fullKey.text}>
              <Highlight text={row.name.text} indices={row.indices} />
            </span>
          </span>
          <KeySummary row={row} />
        </>
      );
      menu = (
        <>
          <ContextMenuItem
            icon="external"
            onSelect={() => {
              openKeyTab(row.connectionId, row.database, row.fullKey);
            }}
          >
            {t('keyValue.tree.open')}
          </ContextMenuItem>
          <ContextMenuItem
            icon="copy"
            onSelect={() => {
              void writeClipboard(row.fullKey.text);
            }}
          >
            {t('keyValue.tree.copyKey')}
          </ContextMenuItem>
        </>
      );
      break;
  }

  const body = (
    <div
      {...common}
      aria-expanded={row.expandable ? row.expanded : undefined}
      aria-label={kvRowName(row)}
      className={rowStyles.row}
      onClick={() => {
        onSelect(index);
        if (row.expandable) onToggle(row);
      }}
      onDoubleClick={() => {
        onOpen(row);
      }}
    >
      {twisty}
      {content}
    </div>
  );
  return <ContextMenu content={menu}>{body}</ContextMenu>;
});
