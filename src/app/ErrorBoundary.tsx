import { Component, type ErrorInfo, type ReactNode } from 'react';

import { translate, useI18nStore } from '../i18n/i18n';
import { nativeWindow } from '../ipc/nativeWindow';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import styles from './ErrorBoundary.module.css';

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Last-resort screen when rendering crashes. React only supports error boundaries as class
 * components. The window starts hidden, so it is shown here too.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('yadbe crashed while rendering', error, info.componentStack);
    void nativeWindow.show().catch(() => undefined);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { locale } = useI18nStore.getState();
    return (
      <div className={styles.screen} role="alert">
        <div className={styles.card}>
          <Icon name="error" size="lg" className={styles.icon} />
          <h1 className={styles.title}>{translate(locale, 'crash.title')}</h1>
          <p className={styles.text}>{translate(locale, 'crash.text')}</p>
          <details className={styles.detail}>
            <summary>{translate(locale, 'common.details')}</summary>
            <pre>{error.stack ?? error.message}</pre>
          </details>
          <Button
            variant="primary"
            onClick={() => {
              window.location.reload();
            }}
          >
            <Icon name="retry" />
            {translate(locale, 'crash.reload')}
          </Button>
        </div>
      </div>
    );
  }
}
