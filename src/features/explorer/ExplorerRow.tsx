import { memo, type CSSProperties, type ReactNode } from 'react';

import { formatNumber, useI18nStore, type Locale } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/Icon';
import { Spinner } from '../../ui/Spinner';
import { Tooltip } from '../../ui/Tooltip';
import { Highlight } from '../connections/Highlight';
import { RenameField } from '../objects/RenameField';
import { useRenameStore } from '../objects/renameStore';
import { rowStyle } from '../sidebar/rowStyle';
import styles from './ExplorerRow.module.css';
import { explorerRowLabel, GROUP_ICONS, groupLabel, kindLabel, KIND_ICONS } from './explorerLabels';
import type { CollectionKind } from '../../ipc';
import { fieldShare } from './documentRows';
import { DocumentContextMenu } from './DocumentContextMenu';
import { SearchContextMenu } from './SearchContextMenu';
import type { SearchGroupKind } from './searchRows';
import type { ExplorerRow as Row } from './explorerRows';
import { ExplorerContextMenu } from './ExplorerContextMenu';

export interface ExplorerRowProps {
  row: Row;
  id: string;
  index: number;
  active: boolean;
  posInSet: number;
  setSize: number;
  /** Distance from the top of the list, and the height of the row, in px. */
  offset: number;
  height: number;
  onSelect: (index: number) => void;
  onToggle: (row: Row) => void;
  onOpen: (row: Row) => void;
  onRefresh: (row: Row) => void;
}

type Translate = ReturnType<typeof useT>;

interface Content {
  icon: IconName | null;
  /** CSS class of the icon (color). */
  iconTone?: string;
  /** The name, highlighted while filtering. */
  name: ReactNode;
  /** What follows the name: a type, a count… */
  meta?: ReactNode;
  /** Small icons after the meta (identity, generated…). */
  badges?: IconName[];
  /** Details shown in a tooltip. */
  tooltip?: ReactNode;
}

function Lines({ lines }: { lines: (string | null | undefined | false)[] }) {
  return (
    <span className={styles.tooltip}>
      {lines.map((line, index) =>
        line ? (
          <span key={index} className={index === 0 ? styles.tooltipTitle : undefined}>
            {line}
          </span>
        ) : null,
      )}
    </span>
  );
}

function contentOf(row: Row, t: Translate, locale: Locale): Content {
  const name = (text: string) => <Highlight text={text} indices={row.indices} />;
  switch (row.type) {
    case 'database':
      return {
        icon: 'database',
        name: name(row.database.name),
        tooltip: row.database.accessible ? (
          row.database.comment ? (
            <Lines lines={[row.database.name, row.database.comment]} />
          ) : undefined
        ) : (
          <Lines lines={[row.database.name, t('explorer.noAccess')]} />
        ),
      };
    case 'schema':
      return {
        icon: 'layers',
        name: name(row.schema.name),
        tooltip: row.schema.comment ? (
          <Lines lines={[row.schema.name, row.schema.comment]} />
        ) : undefined,
      };
    case 'kind':
      return {
        icon: KIND_ICONS[row.kind],
        name: kindLabel(t, row.kind),
        meta: <span className={styles.count}>{formatNumber(locale, row.count)}</span>,
      };
    case 'object': {
      const { object } = row;
      const detail = object.detail;
      let meta: ReactNode;
      if (detail.type === 'routine') {
        meta = `(${detail.arguments})`;
      } else if (detail.type === 'sequence') {
        meta = detail.dataType;
      } else if (detail.type === 'type') {
        meta = detail.category;
      }
      return {
        icon: KIND_ICONS[object.kind],
        name: name(object.name),
        meta,
        tooltip: object.comment ? <Lines lines={[object.name, object.comment]} /> : undefined,
      };
    }
    case 'pinnedGroup':
      return {
        icon: 'pin',
        name: t('explorer.pinned'),
        meta: <span className={styles.count}>{formatNumber(locale, row.count)}</span>,
      };
    case 'pinned': {
      const { pin } = row;
      const where = pin.kind === null ? null : (pin.schema ?? pin.database);
      return {
        icon: pin.kind === null ? 'layers' : KIND_ICONS[pin.kind],
        iconTone: row.missing ? styles.mutedTone : undefined,
        name: name(pin.name),
        meta: row.missing ? t('explorer.pinned.missing') : where,
        badges: row.missing ? ['warning'] : [],
        tooltip: (
          <Lines
            lines={[
              pin.name,
              [pin.database, pin.schema].filter(Boolean).join(' · '),
              row.missing && t('explorer.pinned.missing'),
            ]}
          />
        ),
      };
    }
    case 'detailGroup':
      return {
        icon: GROUP_ICONS[row.group],
        name: groupLabel(t, row.group),
        meta: <span className={styles.count}>{formatNumber(locale, row.count)}</span>,
      };
    case 'column': {
      const { column } = row;
      const badges: IconName[] = [];
      if (column.primaryKey && column.foreignKey) badges.push('link');
      if (column.identity !== null) badges.push('hash');
      if (column.generated !== null) badges.push('formula');
      const icon: IconName = column.primaryKey ? 'key' : column.foreignKey ? 'link' : 'columns';
      return {
        icon,
        iconTone: column.primaryKey
          ? styles.keyTone
          : column.foreignKey
            ? styles.linkTone
            : styles.mutedTone,
        name: name(column.name),
        meta: (
          <>
            {column.typeName}
            <span className={styles.nullability}>
              {column.nullable ? ' · NULL' : ' · NOT NULL'}
            </span>
          </>
        ),
        badges,
        tooltip: (
          <Lines
            lines={[
              `${column.name}: ${column.typeName}`,
              column.nullable ? t('explorer.col.nullable') : t('explorer.col.notNull'),
              column.default !== null && `${t('explorer.col.default')}: ${column.default}`,
              column.primaryKey && t('explorer.col.primaryKey'),
              column.foreignKey && t('explorer.col.foreignKey'),
              column.identity !== null && t(`explorer.col.identity.${column.identity}`),
              column.generated !== null &&
                `${t(column.generated.stored ? 'explorer.col.generated.stored' : 'explorer.col.generated.virtual')}${column.generated.expression ? `: ${column.generated.expression}` : ''}`,
              column.comment,
            ]}
          />
        ),
      };
    }
    case 'key':
      return {
        icon: 'key',
        iconTone: row.primary ? styles.keyTone : undefined,
        name: name(row.name ?? row.columns.join(', ')),
        meta: `${row.primary ? t('explorer.key.primary') : t('explorer.key.unique')} (${row.columns.join(', ')})`,
      };
    case 'foreignKey': {
      const { foreignKey } = row;
      const target = foreignKey.referencedTable;
      const targetName = target.schema === null ? target.name : `${target.schema}.${target.name}`;
      return {
        icon: 'link',
        iconTone: styles.linkTone,
        name: name(foreignKey.name ?? foreignKey.columns.join(', ')),
        meta: `→ ${targetName} (${foreignKey.referencedColumns.join(', ')})`,
        tooltip: (
          <Lines
            lines={[
              `${foreignKey.columns.join(', ')} → ${targetName} (${foreignKey.referencedColumns.join(', ')})`,
              t('explorer.fk.onDelete', { action: foreignKey.onDelete }),
              t('explorer.fk.onUpdate', { action: foreignKey.onUpdate }),
            ]}
          />
        ),
      };
    }
    case 'index': {
      const { index } = row;
      const flags = [
        index.primary
          ? t('explorer.index.primary')
          : index.unique
            ? t('explorer.index.unique')
            : '',
        index.method ?? '',
      ].filter(Boolean);
      return {
        icon: 'index',
        name: name(index.name),
        meta: `${flags.length > 0 ? `${flags.join(', ')} ` : ''}(${index.columns.join(', ')})`,
        tooltip: index.definition ? <Lines lines={[index.name, index.definition]} /> : undefined,
      };
    }
    case 'check':
      return {
        icon: 'checkSquare',
        name: name(row.check.name ?? row.check.expression),
        meta: row.check.name ? row.check.expression : undefined,
        tooltip: <Lines lines={[row.check.name, row.check.expression]} />,
      };
    case 'trigger': {
      const { trigger } = row;
      const timing = trigger.timing === 'insteadOf' ? 'INSTEAD OF' : trigger.timing.toUpperCase();
      return {
        icon: 'bolt',
        name: name(trigger.name),
        meta: `${timing} ${trigger.events.map((event) => event.toUpperCase()).join(' OR ')}${trigger.enabled ? '' : ` · ${t('explorer.trigger.disabled')}`}`,
        tooltip: (
          <Lines
            lines={[
              trigger.name,
              trigger.function,
              trigger.forEachRow
                ? t('explorer.trigger.rowLevel')
                : t('explorer.trigger.statementLevel'),
              trigger.definition,
            ]}
          />
        ),
      };
    }
    case 'status':
      return { icon: null, name: explorerRowLabel(row, t) };
    case 'docDatabase':
      return {
        icon: 'database',
        name: name(row.database.name),
        meta:
          row.database.sizeOnDisk === null
            ? undefined
            : formatBytes(locale, row.database.sizeOnDisk),
      };
    case 'docCollection': {
      const { collection } = row;
      return {
        icon: COLLECTION_ICONS[collection.kind],
        name: name(collection.name),
        meta: collection.kind === 'collection' ? undefined : t(`mongo.explorer.${collection.kind}`),
        tooltip:
          collection.viewOn === null ? undefined : (
            <Lines
              lines={[collection.name, t('mongo.explorer.viewOn', { name: collection.viewOn })]}
            />
          ),
      };
    }
    case 'docGroup':
      return {
        icon: row.group === 'fields' ? 'columns' : 'index',
        name: t(row.group === 'fields' ? 'mongo.explorer.fields' : 'mongo.explorer.indexes'),
        meta:
          row.group === 'fields' && row.sampled !== null ? (
            <span className={styles.count}>
              {t('mongo.explorer.sampled', { count: formatNumber(locale, row.sampled) })}
            </span>
          ) : row.group === 'indexes' && row.count > 0 ? (
            <span className={styles.count}>{formatNumber(locale, row.count)}</span>
          ) : undefined,
        tooltip:
          row.group === 'fields' ? (
            <Lines lines={[t('mongo.explorer.fields'), t('mongo.explorer.estimate')]} />
          ) : undefined,
      };
    case 'docField': {
      const { field, sampled } = row;
      const share = fieldShare(field.present, sampled);
      return {
        icon: field.path === '_id' ? 'key' : 'columns',
        iconTone: field.path === '_id' ? styles.keyTone : styles.mutedTone,
        // A nested field shows its path: the sample lists every path under one group.
        name: name(field.path),
        meta: (
          <>
            {field.types.map((type) => type.type).join(' | ')}
            {share < 100 && <span className={styles.nullability}>{` · ${String(share)}%`}</span>}
          </>
        ),
        tooltip: (
          <Lines
            lines={[
              field.path,
              t('mongo.explorer.present', {
                share: String(share),
                count: formatNumber(locale, field.present),
                sampled: formatNumber(locale, sampled),
              }),
              ...field.types.map(
                (type) => `${type.type}: ${String(fieldShare(type.count, sampled))}%`,
              ),
              t('mongo.explorer.estimate'),
            ]}
          />
        ),
      };
    }
    case 'docIndex': {
      const { index } = row;
      const flags = [
        index.unique && t('mongo.explorer.index.unique'),
        index.sparse && t('mongo.explorer.index.sparse'),
        index.partial && t('mongo.explorer.index.partial'),
        index.hidden && t('mongo.explorer.index.hidden'),
        index.expireAfterSecs !== null &&
          t('mongo.explorer.index.ttl', { seconds: formatNumber(locale, index.expireAfterSecs) }),
      ].filter(Boolean);
      return {
        icon: 'index',
        iconTone: index.name === '_id_' ? styles.keyTone : undefined,
        name: name(index.name),
        meta: `${flags.length > 0 ? `${flags.join(', ')} ` : ''}${index.keys}`,
        tooltip: <Lines lines={[index.name, index.keys, ...flags]} />,
      };
    }
    case 'searchGroup':
      return {
        icon: SEARCH_GROUP_ICONS[row.group],
        name: t(`search.explorer.${row.group}`),
        meta:
          row.count === null ? undefined : (
            <span className={styles.count}>{formatNumber(locale, row.count)}</span>
          ),
      };
    case 'searchIndex': {
      const { index } = row;
      const docs =
        index.docs === null
          ? null
          : t('search.explorer.docs', { count: formatNumber(locale, index.docs) });
      const size = index.sizeBytes === null ? null : formatBytes(locale, index.sizeBytes);
      return {
        icon: 'table',
        iconTone: !index.open
          ? styles.mutedTone
          : index.health === 'red'
            ? styles.errorTone
            : index.health === 'yellow'
              ? styles.keyTone
              : undefined,
        name: name(index.name),
        meta: [docs, size, !index.open && t('search.explorer.closed')].filter(Boolean).join(' · '),
        tooltip: (
          <Lines
            lines={[
              index.name,
              t(`search.health.${index.health}`),
              docs,
              size,
              index.primaries === null
                ? null
                : t('search.explorer.shards', {
                    primaries: index.primaries,
                    replicas: index.replicas ?? 0,
                  }),
              !index.open && t('search.explorer.closed'),
            ]}
          />
        ),
      };
    }
    case 'searchDataStream': {
      const { stream } = row;
      return {
        icon: 'timeline',
        name: name(stream.name),
        meta: t('search.explorer.backing', { count: stream.indices.length }),
        tooltip: (
          <Lines
            lines={[
              stream.name,
              t(`search.health.${stream.health}`),
              stream.template && t('search.explorer.template', { name: stream.template }),
              stream.timestampField &&
                t('search.explorer.timestamp', { field: stream.timestampField }),
              ...stream.indices,
            ]}
          />
        ),
      };
    }
    case 'searchAlias': {
      const { alias } = row;
      return {
        icon: 'link',
        iconTone: styles.linkTone,
        name: name(alias.name),
        meta: `→ ${alias.indices.join(', ')}`,
        badges: alias.filtered ? ['filter'] : undefined,
        tooltip: (
          <Lines
            lines={[
              alias.name,
              ...alias.indices,
              alias.writeIndex && t('search.explorer.writeIndex', { name: alias.writeIndex }),
              alias.filtered && t('search.explorer.filtered'),
            ]}
          />
        ),
      };
    }
    case 'searchTemplate': {
      const { template } = row;
      return {
        icon: 'layers',
        name: name(template.name),
        meta: template.patterns.join(', '),
        tooltip: (
          <Lines
            lines={[
              template.name,
              template.patterns.join(', '),
              template.priority !== null &&
                t('search.explorer.priority', { priority: template.priority }),
              template.dataStream && t('search.explorer.createsStreams'),
            ]}
          />
        ),
      };
    }
    case 'searchDetails':
      return {
        icon: row.detail === 'fields' ? 'columns' : 'settings',
        name: t(`search.explorer.${row.detail}`),
        meta:
          row.count > 0 ? (
            <span className={styles.count}>{formatNumber(locale, row.count)}</span>
          ) : undefined,
      };
    case 'searchField': {
      const { field } = row;
      return {
        icon: 'columns',
        iconTone: field.multiField ? styles.mutedTone : undefined,
        name: name(field.path),
        meta: field.typeName,
        badges: field.sortable ? ['arrowDown'] : undefined,
        tooltip: (
          <Lines
            lines={[
              field.path,
              field.typeName,
              field.sortable && t('search.explorer.sortable'),
              field.multiField && t('search.explorer.multiField'),
            ]}
          />
        ),
      };
    }
    case 'searchSetting':
      return {
        icon: null,
        name: name(row.setting.key.replace(/^index\./, '')),
        meta: row.setting.value,
        tooltip: <Lines lines={[row.setting.key, row.setting.value]} />,
      };
  }
}

/** Rows that open a tab: a click only selects them, a double click opens. */
const OPENS_ON_DOUBLE_CLICK: ReadonlySet<Row['type']> = new Set([
  'object',
  'docCollection',
  'searchIndex',
  'searchDataStream',
  'searchAlias',
]);

const SEARCH_GROUP_ICONS: Record<SearchGroupKind, IconName> = {
  indices: 'table',
  dataStreams: 'timeline',
  aliases: 'link',
  templates: 'layers',
};

const COLLECTION_ICONS: Record<CollectionKind, IconName> = {
  collection: 'table',
  view: 'view',
  timeseries: 'timeline',
};

function formatBytes(locale: Locale, bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${formatNumber(locale, Math.round(value * 10) / 10)} ${units[unit] ?? 'B'}`;
}

/** One row of an open connection's tree: database, schema, kind, object, column… (F-020, F-021). */
export const ExplorerRow = memo(function ExplorerRow({
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
}: ExplorerRowProps) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const renaming = useRenameStore(
    (state) =>
      state.target !== null &&
      state.target.nodeKey === row.nodeKey &&
      state.target.connectionId === row.connectionId,
  );
  const depth = row.level - 1;
  const common = {
    id,
    role: 'treeitem',
    'aria-level': row.level,
    'aria-posinset': posInSet,
    'aria-setsize': setSize,
    'data-row-index': index,
    'data-active': active || undefined,
    style: { ...rowStyle(offset, height), '--depth': depth } as CSSProperties,
  };

  if (row.type === 'status') {
    const failed = row.status === 'error';
    const message = explorerRowLabel(row, t);
    return (
      <div
        {...common}
        aria-selected={active}
        aria-label={message}
        data-status={row.status}
        className={styles.row}
        onClick={() => {
          onSelect(index);
        }}
      >
        <span className={styles.twisty} />
        {row.status === 'loading' && <Spinner />}
        {failed && <Icon name="warning" className={styles.errorTone} />}
        <span className={styles.statusText} title={message}>
          {message}
        </span>
        {failed && (
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

  const content = contentOf(row, t, locale);
  if (renaming) content.name = <RenameField row={row} name={explorerRowLabel(row, t)} />;
  const disabled = row.type === 'database' && !row.database.accessible;
  const refreshable =
    row.type === 'docDatabase' ||
    row.type === 'docCollection' ||
    row.type === 'searchGroup' ||
    row.type === 'searchIndex' ||
    row.type === 'searchDataStream' ||
    row.type === 'searchAlias' ||
    row.type === 'database' ||
    row.type === 'schema' ||
    row.type === 'kind' ||
    (row.type === 'object' && row.expandable);
  const missing = row.type === 'pinned' && row.missing;
  const label = explorerRowLabel(row, t);
  const ariaLabel = row.type === 'column' ? `${label}, ${row.column.typeName}` : label;

  const body = (
    <div
      {...common}
      aria-selected={active}
      aria-expanded={row.expandable ? row.expanded : undefined}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      data-type={row.type}
      data-missing={missing || undefined}
      className={styles.row}
      onClick={() => {
        onSelect(index);
        // Containers open with a click; objects and connections only select (double click opens).
        if (row.expandable && !OPENS_ON_DOUBLE_CLICK.has(row.type)) {
          onToggle(row);
        }
      }}
      onDoubleClick={() => {
        onOpen(row);
      }}
    >
      <span
        className={styles.twisty}
        onClick={(event) => {
          if (!row.expandable) return;
          event.stopPropagation();
          onSelect(index);
          onToggle(row);
        }}
      >
        {row.expandable && <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} />}
      </span>
      {content.icon && (
        <Icon
          name={content.icon}
          className={[styles.icon, content.iconTone].filter(Boolean).join(' ')}
        />
      )}
      {(() => {
        const text = (
          <span className={styles.text}>
            <span className={styles.name}>{content.name}</span>
            {content.meta !== undefined && <span className={styles.meta}>{content.meta}</span>}
          </span>
        );
        return content.tooltip ? (
          <Tooltip side="right" content={content.tooltip}>
            {text}
          </Tooltip>
        ) : (
          text
        );
      })()}
      {content.badges?.map((badge, position) => (
        <Icon key={position} name={badge} className={styles.badge} />
      ))}
      {refreshable && (
        <button
          type="button"
          tabIndex={-1}
          className={styles.refresh}
          aria-label={t('explorer.refresh', { name: label })}
          onClick={(event) => {
            event.stopPropagation();
            onRefresh(row);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
          }}
        >
          <Icon name="retry" />
        </button>
      )}
    </div>
  );
  if (row.type.startsWith('doc')) {
    return <DocumentContextMenu row={row}>{body}</DocumentContextMenu>;
  }
  if (row.type.startsWith('search')) {
    return <SearchContextMenu row={row}>{body}</SearchContextMenu>;
  }
  return <ExplorerContextMenu row={row}>{body}</ExplorerContextMenu>;
});
