import type { CSSProperties } from 'react';

import { useT } from '../../i18n/useT';
import { tintOf, type ConnectionSummary } from '../connections/model';
import styles from './ConnectionTag.module.css';

interface ConnectionTagProps {
  /** `undefined`: the connection was deleted since. */
  connection: ConnectionSummary | undefined;
  /** The name the connection had when the statement ran. */
  name: string;
}

/** The connection of an entry, with the color of its environment (a deleted one is struck dim). */
export function ConnectionTag({ connection, name }: ConnectionTagProps) {
  const t = useT();
  const tint = connection ? tintOf(connection) : null;
  const label = connection ? connection.name : t('history.connectionDeleted', { name });
  return (
    <span
      className={styles.tag}
      data-environment={connection?.environment ?? undefined}
      data-deleted={connection === undefined || undefined}
      style={tint ? ({ '--tag-color': tint } as CSSProperties) : undefined}
      title={label}
    >
      {label}
    </span>
  );
}
