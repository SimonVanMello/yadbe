import type { CSSProperties } from 'react';

import { useT } from '../../i18n/useT';
import styles from './EnvTag.module.css';
import type { EnvironmentKind } from './model';

interface EnvTagProps {
  environment: EnvironmentKind;
  /** Label of a `custom` environment. */
  label: string | null;
  /** Token of the color, for a custom environment (the picked color of the connection). */
  tint: string | null;
  /** Larger and solid, where acting on the wrong environment costs the most. */
  prominent?: boolean;
}

/** Environment pill (F-007): dev, staging, prod or the user's own label, in its color. */
export function EnvTag({ environment, label, tint, prominent = false }: EnvTagProps) {
  const t = useT();
  const text =
    environment === 'custom' ? (label ?? t('environment.custom')) : t(`environment.${environment}`);
  return (
    <span
      className={styles.tag}
      data-environment={environment}
      data-prominent={prominent || undefined}
      style={
        environment === 'custom' && tint ? ({ '--env-color': tint } as CSSProperties) : undefined
      }
    >
      {text}
    </span>
  );
}
