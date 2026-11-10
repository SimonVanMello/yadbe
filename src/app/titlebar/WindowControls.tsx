import { useEffect, useState } from 'react';

import { useT } from '../../i18n/useT';
import { nativeWindow } from '../../ipc/nativeWindow';
import { Icon, type IconName } from '../../ui/Icon';
import styles from './WindowControls.module.css';

/** Tracks the maximized state, so the middle button reads "Restore" when maximized. */
function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void nativeWindow.isMaximized().then(
        (value) => {
          if (active) setMaximized(value);
        },
        () => undefined,
      );
    };
    refresh();
    const unsubscribe = nativeWindow.subscribeResized(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return maximized;
}

/** Minimize / maximize-restore / close buttons of the undecorated window on Windows and Linux. */
export function WindowControls() {
  const t = useT();
  const maximized = useMaximized();
  const buttons: { icon: IconName; label: string; action: () => Promise<void>; close?: true }[] = [
    { icon: 'windowMinimize', label: t('window.minimize'), action: nativeWindow.minimize },
    {
      icon: maximized ? 'windowRestore' : 'windowMaximize',
      label: maximized ? t('window.restore') : t('window.maximize'),
      action: nativeWindow.toggleMaximize,
    },
    { icon: 'windowClose', label: t('window.close'), action: nativeWindow.close, close: true },
  ];
  return (
    <div className={styles.controls} role="group" aria-label={t('window.controls')}>
      {buttons.map((button) => (
        <button
          key={button.close ? 'close' : button.icon}
          type="button"
          aria-label={button.label}
          title={button.label}
          className={[styles.button, button.close ? styles.close : ''].filter(Boolean).join(' ')}
          onClick={() => {
            void button.action();
          }}
        >
          <Icon name={button.icon} />
        </button>
      ))}
    </div>
  );
}
