import type {
  CSSProperties,
  HTMLAttributes,
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  Ref,
} from 'react';

import { useConnection, useConnectionState } from '../../features/connections/connectionStore';
import {
  useDiffersFromSaved,
  useIsDirty,
  useTabFileName,
} from '../../features/query/queryTabStore';
import {
  ddlTargetKind,
  ddlTargetName,
  ddlTargetObject,
  toolKindKey,
} from '../../features/objects/objectsModel';
import { tableLabel } from '../../features/table-data/tableNames';
import { toolTabIcon, toolTabName, toolTabTooltip } from '../../features/tools/toolTabs';
import { usePendingCount } from '../../features/table-data/tableSessionStore';
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
  const fileName = useTabFileName(tab.id);
  const edited = useIsDirty(tab.id);
  const savedChanged = useDiffersFromSaved(tab.id);
  const pending = usePendingCount(tab.id);

  const isWelcome = tab.connectionId === null;
  const pinned = tab.pinned && !isWelcome;
  const { table, ddl, tool } = tab;
  // A table tab's mark is its pending changes, never saved with the tab.
  const dirty = table ? pending > 0 : edited;
  const name = isWelcome
    ? t('tab.new')
    : table
      ? table.name
      : ddl
        ? ddlTargetName(ddl)
        : tool
          ? toolTabName(tool, t)
          : (fileName ?? t('tab.query', { number: tab.ordinal }));
  const tint = connection ? tintOf(connection) : null;

  const tooltip = isWelcome ? (
    t('tab.new')
  ) : (
    <span className={styles.tooltip}>
      <span className={styles.tooltipName}>
        {table
          ? tableLabel(table)
          : ddl
            ? t('objects.ddl.tooltip', {
                kind: t(toolKindKey(ddlTargetKind(ddl))),
                name: tableLabel({ schema: ddlTargetObject(ddl).schema, name }),
              })
            : tool
              ? toolTabTooltip(tool, t)
              : name}
      </span>
      {table && pending > 0 && <span>{t('tableData.pending', { count: pending })}</span>}
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
          ...(dirty && !isWelcome
            ? [table ? t('tableData.pending', { count: pending }) : t('tab.unsaved')]
            : []),
          ...(savedChanged && !table && !isWelcome ? [t('tab.savedChanged')] : []),
          ...(connection ? [connection.name] : []),
          ...(pinned ? [t('tab.pinned')] : []),
        ].join(', ')}
        tabIndex={active ? 0 : -1}
        data-tab-id={tab.id}
        data-dragging={dragging || undefined}
        data-pinned={pinned || undefined}
        data-kind={table ? 'table' : ddl ? 'ddl' : tool ? 'tool' : undefined}
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
        {table && <Icon name="table" className={styles.kind} />}
        {ddl && <Icon name="file" className={styles.kind} />}
        {tool && <Icon name={toolTabIcon(tool)} className={styles.kind} />}
        <span className={styles.label}>{name}</span>
        {dirty && !isWelcome && (
          <span
            className={styles.dirty}
            role="img"
            aria-label={table ? t('tableData.pending', { count: pending }) : t('tab.unsaved')}
          />
        )}
        {savedChanged && !table && !isWelcome && (
          <span
            className={styles.savedChanged}
            role="img"
            aria-label={t('tab.savedChanged')}
            title={t('tab.savedChanged')}
          />
        )}
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
