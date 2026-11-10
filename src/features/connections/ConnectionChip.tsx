import type { CSSProperties } from 'react';

import styles from './ConnectionChip.module.css';
import { EnvTag } from './EnvTag';
import { EngineBadge } from './EngineBadge';
import { StateDot } from './StateDot';
import { tintOf, type ConnectionState, type ConnectionSummary } from './model';

interface ConnectionChipProps {
  connection: ConnectionSummary;
  state: ConnectionState;
  size?: 'sm' | 'md';
}

/**
 * Name, database and environment color of a connection (SPEC §6: "environment always
 * visible"): in the toolbar and in the body of each tab.
 */
export function ConnectionChip({ connection, state, size = 'sm' }: ConnectionChipProps) {
  const tint = tintOf(connection);
  return (
    <span
      className={styles.chip}
      data-size={size}
      data-environment={connection.environment ?? undefined}
      style={tint ? ({ '--chip-color': tint } as CSSProperties) : undefined}
    >
      <StateDot state={state} />
      <EngineBadge engine={connection.engine} />
      <span className={styles.name}>{connection.name}</span>
      {connection.database && <span className={styles.database}>{connection.database}</span>}
      {connection.environment && (
        <EnvTag
          environment={connection.environment}
          label={connection.environmentLabel}
          tint={tint}
        />
      )}
    </span>
  );
}
