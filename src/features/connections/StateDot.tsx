import { useT } from '../../i18n/useT';
import styles from './StateDot.module.css';
import type { ConnectionState } from './model';

interface StateDotProps {
  state: ConnectionState;
  /** Hides the dot from assistive technology when the state is also written next to it. */
  decorative?: boolean;
}

/** Connection state indicator (F-007, F-013): disconnected, connecting, connected, lost. */
export function StateDot({ state, decorative = false }: StateDotProps) {
  const t = useT();
  return (
    <span
      className={styles.dot}
      data-state={state}
      {...(decorative
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': t(`connection.state.${state}`) })}
    />
  );
}
