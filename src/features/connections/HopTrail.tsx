import { Fragment } from 'react';

import { useT } from '../../i18n/useT';
import type { TunnelHop } from '../../ipc';
import { Icon } from '../../ui/Icon';
import styles from './HopTrail.module.css';

export type HopOutcome = 'ok' | 'failed' | 'skipped';

/**
 * The outcome of each hop of a tunnelled test: those before the failed one were reached, those
 * after it were not. Without a failure, every hop was reached.
 */
export function hopOutcomes(
  hops: readonly TunnelHop[],
  failed: TunnelHop | null,
): [TunnelHop, HopOutcome][] {
  const at = failed === null ? -1 : hops.indexOf(failed);
  return hops.map((hop, index) => [
    hop,
    at === -1 ? 'ok' : index < at ? 'ok' : index === at ? 'failed' : 'skipped',
  ]);
}

const ICONS: Record<HopOutcome, 'check' | 'error' | 'minus'> = {
  ok: 'check',
  failed: 'error',
  skipped: 'minus',
};

/** "Jump host ✓ → SSH server ✗ → Database –": which hop of the tunnel a test failed at. */
export function HopTrail({
  hops,
  failed,
}: {
  hops: readonly TunnelHop[];
  failed: TunnelHop | null;
}) {
  const t = useT();
  return (
    <ol className={styles.trail} aria-label={t('connection.test.hops')}>
      {hopOutcomes(hops, failed).map(([hop, outcome], index) => (
        <Fragment key={hop}>
          {index > 0 && (
            <li className={styles.arrow} aria-hidden>
              <Icon name="chevronRight" />
            </li>
          )}
          <li className={styles.hop} data-outcome={outcome}>
            <Icon name={ICONS[outcome]} />
            <span>{t(`connection.test.hop.${hop}`)}</span>
            <span className={styles.visuallyHidden}>{t(`connection.test.hop.${outcome}`)}</span>
          </li>
        </Fragment>
      ))}
    </ol>
  );
}
