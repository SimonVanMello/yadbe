import type { ReactNode } from 'react';

import { useT } from '../../i18n/useT';
import type { YadbeError } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import styles from './ErrorPanel.module.css';
import { localize, resolveErrorAction, type ErrorContext } from './presentError';

interface ErrorPanelProps {
  title: string;
  error: YadbeError;
  context?: ErrorContext;
  /** Extra buttons after the suggested action. */
  children?: ReactNode;
  compact?: boolean;
}

/** Inline display of a typed error: message, suggested action and raw detail (F-124). */
export function ErrorPanel({ title, error, context, children, compact = false }: ErrorPanelProps) {
  const t = useT();
  const action = resolveErrorAction(error.action, context);
  return (
    <div
      className={[styles.panel, compact ? styles.compact : ''].filter(Boolean).join(' ')}
      role="alert"
    >
      <Icon name="error" size={compact ? 'md' : 'lg'} className={styles.icon} />
      <div className={styles.body}>
        <p className={styles.title}>{title}</p>
        <p className={styles.message}>{localize(error.message)}</p>
        {error.detail && (
          <details className={styles.detail}>
            <summary>{t('common.details')}</summary>
            <pre>{error.detail}</pre>
          </details>
        )}
        {(action ?? children) && (
          <div className={styles.actions}>
            {action && (
              <Button variant="primary" size={compact ? 'sm' : 'md'} onClick={action.run}>
                {action.label}
              </Button>
            )}
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
