import type {
  CSSProperties,
  HTMLAttributes,
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  Ref,
} from 'react';

import { useConnection, useConnectionState } from '../../features/connections/connectionStore';
import { EnvTag } from '../../features/connections/EnvTag';
import { StateDot } from '../../features/connections/StateDot';
import { tintOf } from '../../features/connections/model';
import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';
import type { ShellTab } from '../tabs/tabsStore';
import styles from './TabItem.module.css';

interface TabItemProps extends HTMLAttributes<HTMLDivElement> {
  tab: ShellTab;
  active: boolean;
  dragging: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onClose: () => void;
  /** Props and ref injected by wrapping Radix triggers (handlers are composed by Radix). */
  ref?: Ref<HTMLDivElement>;
}

/** One tab of the title bar: its name, its connection's state and environment color (F-122). */
export function TabItem({
  tab,
  active,
  dragging,
  onPointerDown,
  onKeyDown,
  onClose,
  ...rest
}: TabItemProps) {
  const t = useT();
  const connection = useConnection(tab.connectionId);
  const state = useConnectionState(tab.connectionId);

  const isWelcome = tab.connectionId === null;
  const pinned = tab.pinned && !isWelcome;
  const name = isWelcome ? t('tab.new') : t('tab.query', { number: tab.ordinal });
  const tint = connection ? tintOf(connection) : null;

  const tooltip = isWelcome ? (
    t('tab.new')
  ) : (
    <span className={styles.tooltip}>
      <span className={styles.tooltipName}>{name}</span>
      <span className={styles.tooltipConnection}>
        {connection ? connection.name : t('tab.unknownConnection')}
        {connection?.database && (
          <span className={styles.tooltipDatabase}>{connection.database}</span>
        )}
      </span>
      {connection?.environment && (
        <EnvTag
          environment={connection.environment}
          label={connection.environmentLabel}
          tint={tint}
        />
      )}
      <span>{t(`connection.state.${state}`)}</span>
      {pinned && (
        <span className={styles.tooltipPinned}>
          <Icon name="pin" aria-hidden="true" />
          {t('tab.pinned')}
        </span>
      )}
    </span>
  );

  return (
    <Tooltip content={tooltip} side="bottom">
      <div
        {...rest}
        role="tab"
        id={`tab-${tab.id}`}
        aria-selected={active}
        aria-controls="tab-panel"
        aria-label={[
          name,
          ...(connection ? [connection.name] : []),
          ...(pinned ? [t('tab.pinned')] : []),
        ].join(', ')}
        tabIndex={active ? 0 : -1}
        data-tab-id={tab.id}
        data-dragging={dragging || undefined}
        data-pinned={pinned || undefined}
        data-environment={connection?.environment ?? undefined}
        className={styles.tab}
        style={tint ? ({ '--tab-tint': tint } as CSSProperties) : undefined}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => {
          // Middle click closes the tab: prevent the browser autoscroll.
          if (event.button === 1) event.preventDefault();
        }}
        onAuxClick={(event) => {
          if (event.button === 1) onClose();
        }}
      >
        {!isWelcome && <StateDot state={state} decorative />}
        <span className={styles.label}>{name}</span>
        {!isWelcome && connection && <span className={styles.connection}>{connection.name}</span>}
        {/* A pinned tab closes only on purpose: ⌘W, middle click or its menu. */}
        {!pinned && (
          <button
            type="button"
            tabIndex={-1}
            className={styles.close}
            aria-label={t('tab.close', { name })}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          >
            <Icon name="close" />
          </button>
        )}
      </div>
    </Tooltip>
  );
}
