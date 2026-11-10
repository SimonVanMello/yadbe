import type { CSSProperties } from 'react';

import { EngineBadge } from './EngineBadge';
import { EnvTag } from './EnvTag';
import styles from './ConnectionBanner.module.css';
import { tintOf, type ConnectionSummary } from './model';

interface ConnectionBannerProps {
  connection: Pick<
    ConnectionSummary,
    'name' | 'engine' | 'database' | 'environment' | 'environmentLabel' | 'environmentColor'
  >;
}

/**
 * Where something is about to happen, with the connection's environment (SPEC §6: "environment
 * always visible"): the strip of dialogs that ask before acting. A prod connection gets a
 * stronger tint and a larger tag, so it cannot be mistaken for a dev one.
 */
export function ConnectionBanner({ connection }: ConnectionBannerProps) {
  const tint = tintOf(connection);
  return (
    <div
      className={styles.banner}
      data-environment={connection.environment ?? undefined}
      data-testid="connection-banner"
      style={tint ? ({ '--banner-color': tint } as CSSProperties) : undefined}
    >
      <EngineBadge engine={connection.engine} />
      <span className={styles.name}>{connection.name}</span>
      {connection.database && <span className={styles.database}>{connection.database}</span>}
      {connection.environment && (
        <span className={styles.tag}>
          <EnvTag
            environment={connection.environment}
            label={connection.environmentLabel}
            tint={tint}
            prominent={connection.environment === 'prod'}
          />
        </span>
      )}
    </div>
  );
}
