import type { CSSProperties, KeyboardEvent } from 'react';

import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';
import { openQuery, toggleFavorite } from '../connections/connectionActions';
import { ConnectionContextMenu } from '../connections/ConnectionContextMenu';
import { useConnectionState, useEngineInfo } from '../connections/connectionStore';
import { EnvTag } from '../connections/EnvTag';
import { Highlight } from '../connections/Highlight';
import { StateDot } from '../connections/StateDot';
import { tintOf, type ConnectionSummary } from '../connections/model';
import styles from './ConnectionRow.module.css';

interface ConnectionRowProps {
  connection: ConnectionSummary;
  nameIndices: readonly number[];
  depth: number;
  focused: boolean;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

/** One saved connection of the sidebar: state, engine, name, environment, favorite (F-007). */
export function ConnectionRow({
  connection,
  nameIndices,
  depth,
  focused,
  onFocus,
  onKeyDown,
}: ConnectionRowProps) {
  const t = useT();
  const state = useConnectionState(connection.id);
  const engine = useEngineInfo(connection.engine);
  const tint = tintOf(connection);

  return (
    <ConnectionContextMenu connection={connection}>
      <div
        role="treeitem"
        aria-selected={false}
        aria-level={depth + 1}
        aria-label={`${connection.name}, ${t(`connection.state.${state}`)}`}
        tabIndex={focused ? 0 : -1}
        data-row-id={`connection:${connection.id}`}
        data-connection-id={connection.id}
        data-state={state}
        className={styles.row}
        style={{ '--depth': depth, '--row-tint': tint ?? 'transparent' } as CSSProperties}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onDoubleClick={() => {
          openQuery(connection);
        }}
      >
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
            <Highlight text={connection.name} indices={nameIndices} />
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
        <button
          type="button"
          tabIndex={-1}
          className={styles.favorite}
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
}
