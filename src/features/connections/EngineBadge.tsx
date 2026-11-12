import styles from './EngineBadge.module.css';
import { useEngineInfo } from './connectionStore';
import type { Engine } from './model';

/** Two-letter marks, as these are product names rather than words to translate. */
const MARKS: Record<Engine, string> = {
  postgres: 'PG',
  mssql: 'MS',
  mysql: 'MY',
  sqlite: 'SL',
  redis: 'RD',
};

/** Small monospace mark of a database engine. */
export function EngineBadge({ engine }: { engine: Engine }) {
  const label = useEngineInfo(engine)?.label ?? engine;
  return (
    <span className={styles.badge} role="img" aria-label={label} title={label}>
      {MARKS[engine]}
    </span>
  );
}
