import type { CSSProperties } from 'react';

import { useShellStore } from '../../app/shellStore';
import { useI18nStore } from '../../i18n/i18n';
import { formatRelativeTime } from '../../i18n/relativeTime';
import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { Tooltip } from '../../ui/Tooltip';
import { toggleFavorite } from '../connections/connectionActions';
import { ConnectionContextMenu } from '../connections/ConnectionContextMenu';
import { useConnectionState } from '../connections/connectionStore';
import { EngineBadge } from '../connections/EngineBadge';
import { EnvTag } from '../connections/EnvTag';
import { Highlight } from '../connections/Highlight';
import { StateDot } from '../connections/StateDot';
import { tintOf, type ConnectionSummary } from '../connections/model';
import styles from './WelcomeRow.module.css';

interface WelcomeRowProps {
  connection: ConnectionSummary;
  id: string;
  selected: boolean;
  /** Shows the selection: while the pointer is on the row or after the arrow keys moved it. */
  active: boolean;
  nameIndices: readonly number[];
  now: number;
  onOpen: () => void;
  onHover: () => void;
  onLeave: () => void;
}

/** A saved connection in the welcome screen list (option of the search listbox). */
export function WelcomeRow({
  connection,
  id,
  selected,
  active,
  nameIndices,
  now,
  onOpen,
  onHover,
  onLeave,
}: WelcomeRowProps) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  const state = useConnectionState(connection.id);
  const tint = tintOf(connection);
  const favoriteLabel = connection.favorite
    ? t('connection.menu.unfavorite')
    : t('connection.menu.favorite');

  return (
    <ConnectionContextMenu connection={connection}>
      <div
        id={id}
        role="option"
        aria-selected={selected}
        data-active={active || undefined}
        className={styles.row}
        style={{ '--row-tint': tint ?? 'transparent' } as CSSProperties}
        onClick={onOpen}
        onMouseMove={onHover}
        onMouseLeave={onLeave}
      >
        <StateDot state={state} />
        <EngineBadge engine={connection.engine} />
        <span className={styles.text}>
          <span className={styles.name}>
            <Highlight text={connection.name} indices={nameIndices} />
          </span>
          <span className={styles.target}>
            {connection.target}
            {connection.database && ` · ${connection.database}`}
          </span>
        </span>
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
        <span className={styles.time}>
          {connection.lastUsedAt === null
            ? t('welcome.neverUsed')
            : formatRelativeTime(connection.lastUsedAt / 1000, now, locale)}
        </span>
        <span className={styles.actions}>
          <Tooltip content={favoriteLabel}>
            <button
              type="button"
              tabIndex={-1}
              aria-label={favoriteLabel}
              aria-pressed={connection.favorite}
              className={styles.action}
              data-favorite={connection.favorite || undefined}
              onClick={(event) => {
                event.stopPropagation();
                void toggleFavorite(connection);
              }}
            >
              <Icon name="star" filled={connection.favorite} />
            </button>
          </Tooltip>
          <Tooltip content={t('connection.menu.edit')}>
            <button
              type="button"
              tabIndex={-1}
              aria-label={t('connection.editNamed', { name: connection.name })}
              className={styles.action}
              onClick={(event) => {
                event.stopPropagation();
                useShellStore.getState().openConnectionDialog({ connectionId: connection.id });
              }}
            >
              <Icon name="pencil" />
            </button>
          </Tooltip>
        </span>
      </div>
    </ConnectionContextMenu>
  );
}
