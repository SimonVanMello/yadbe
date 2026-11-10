import { memo, type CSSProperties } from 'react';

import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';
import { toggleFavorite } from '../connections/connectionActions';
import { ConnectionContextMenu } from '../connections/ConnectionContextMenu';
import { useEngineInfo } from '../connections/connectionStore';
import { EnvTag } from '../connections/EnvTag';
import { Highlight } from '../connections/Highlight';
import { StateDot } from '../connections/StateDot';
import { tintOf } from '../connections/model';
import styles from './ConnectionRow.module.css';
import { rowStyle } from './rowStyle';
import type { SidebarTreeRow } from './sidebarRows';

export type ConnectionTreeRow = Extract<SidebarTreeRow, { type: 'connection' }>;

interface ConnectionRowProps {
  row: ConnectionTreeRow;
  id: string;
  index: number;
  active: boolean;
  posInSet: number;
  setSize: number;
  offset: number;
  height: number;
  onSelect: (index: number) => void;
  onToggle: (row: ConnectionTreeRow) => void;
  onOpen: (row: ConnectionTreeRow) => void;
  onRefresh: (row: ConnectionTreeRow) => void;
}

/** One saved connection of the sidebar: state, engine, name, environment, favorite (F-007). */
export const ConnectionRow = memo(function ConnectionRow({
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
}: ConnectionRowProps) {
  const t = useT();
  const { connection, state } = row;
  const engine = useEngineInfo(connection.engine);
  const tint = tintOf(connection);

  return (
    <ConnectionContextMenu connection={connection}>
      <div
        id={id}
        role="treeitem"
        aria-selected={active}
        aria-level={row.level}
        aria-posinset={posInSet}
        aria-setsize={setSize}
        aria-expanded={row.expanded}
        aria-label={`${connection.name}, ${t(`connection.state.${state}`)}`}
        data-row-index={index}
        data-active={active || undefined}
        data-connection-id={connection.id}
        data-state={state}
        className={styles.row}
        style={
          {
            ...rowStyle(offset, height),
            '--depth': row.level - 1,
            '--row-tint': tint ?? 'transparent',
          } as CSSProperties
        }
        onClick={() => {
          onSelect(index);
        }}
        onDoubleClick={() => {
          onOpen(row);
        }}
      >
        <span
          className={styles.twisty}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(index);
            onToggle(row);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
          }}
        >
          <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} />
        </span>
        <StateDot state={state} decorative />
        <Tooltip
          side="right"
          content={
            <span className={styles.tooltip}>
              <span className={styles.tooltipName}>{connection.name}</span>
              {engine && <span>{engine.label}</span>}
              <span className={styles.tooltipTarget}>
                {connection.target}
                {connection.database && ` · ${connection.database}`}
              </span>
              <span>{t(`connection.state.${state}`)}</span>
              {connection.readOnly && <span>{t('connection.readOnly')}</span>}
            </span>
          }
        >
          <span className={styles.name}>
            <Highlight text={connection.name} indices={row.nameIndices} />
          </span>
        </Tooltip>
        {connection.readOnly && (
          <Icon name="lock" className={styles.lock} aria-label={t('connection.readOnly')} />
        )}
        {connection.environment && (
          <EnvTag
            environment={connection.environment}
            label={connection.environmentLabel}
            tint={tint}
          />
        )}
        {state === 'connected' && (
          <button
            type="button"
            tabIndex={-1}
            className={styles.action}
            aria-label={t('explorer.refresh', { name: connection.name })}
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
        <button
          type="button"
          tabIndex={-1}
          className={styles.action}
          data-active={connection.favorite || undefined}
          aria-pressed={connection.favorite}
          aria-label={
            connection.favorite ? t('connection.menu.unfavorite') : t('connection.menu.favorite')
          }
          onClick={(event) => {
            event.stopPropagation();
            void toggleFavorite(connection);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
          }}
        >
          <Icon name="star" filled={connection.favorite} />
        </button>
      </div>
    </ConnectionContextMenu>
  );
});
