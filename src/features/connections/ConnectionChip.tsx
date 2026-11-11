import type { CSSProperties } from 'react';

import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';

import styles from './ConnectionChip.module.css';
import { EnvTag } from './EnvTag';
import { EngineBadge } from './EngineBadge';
import { StateDot } from './StateDot';
import { tintOf, type ConnectionState, type ConnectionSummary } from './model';
import { endpointOfHop } from './sshModel';

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
  const t = useT();
  const tint = tintOf(connection);
  const ssh = connection.definition.ssh;
  const via = ssh
    ? ssh.jump
      ? t('connection.tunnel.viaJump', {
          endpoint: endpointOfHop(ssh.server),
          jump: endpointOfHop(ssh.jump),
        })
      : t('connection.tunnel.via', { endpoint: endpointOfHop(ssh.server) })
    : null;
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
      {via && (
        <span className={styles.tunnel} title={via} aria-label={via} data-testid="tunnel-indicator">
          <Icon name="tunnel" />
        </span>
      )}
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
