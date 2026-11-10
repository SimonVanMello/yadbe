import { Toast } from 'radix-ui';

import { useT } from '../i18n/useT';
import { Icon, type IconName } from './Icon';
import styles from './Toaster.module.css';
import { useToastStore, type ToastVariant } from './toastStore';

const ICONS: Record<ToastVariant, IconName> = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  error: 'error',
};

/** Renders the toasts pushed with `toast()`. Mount once at the app root. */
export function Toaster() {
  const t = useT();
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  return (
    <Toast.Provider swipeDirection="right" label={t('common.close')}>
      {toasts.map((item) => (
        <Toast.Root
          key={item.id}
          className={[styles.toast, styles[item.variant]].join(' ')}
          duration={item.duration}
          type={item.variant === 'error' ? 'foreground' : 'background'}
          onOpenChange={(open) => {
            if (!open) dismiss(item.id);
          }}
        >
          <Icon name={ICONS[item.variant]} size="md" className={styles.icon} />
          <div className={styles.body}>
            <Toast.Title className={styles.title}>{item.title}</Toast.Title>
            {item.description && (
              <Toast.Description className={styles.description}>
                {item.description}
              </Toast.Description>
            )}
            {item.detail && (
              <details className={styles.detail}>
                <summary>{t('common.details')}</summary>
                <pre>{item.detail}</pre>
              </details>
            )}
          </div>
          {item.action && (
            <Toast.Action
              className={styles.action}
              altText={item.action.label}
              onClick={item.action.onClick}
            >
              {item.action.label}
            </Toast.Action>
          )}
          <Toast.Close className={styles.close} aria-label={t('common.close')}>
            <Icon name="close" />
          </Toast.Close>
        </Toast.Root>
      ))}
      <Toast.Viewport className={styles.viewport} />
    </Toast.Provider>
  );
}
