import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { useConfirmStore } from './confirmStore';
import styles from './ConfirmDialog.module.css';

/** Renders the pending `confirm()` request. Mount once at the app root. */
export function ConfirmDialog() {
  const t = useT();
  const pending = useConfirmStore((state) => state.pending);
  const settle = useConfirmStore((state) => state.settle);
  if (!pending) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
      title={pending.title}
      description={pending.description}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              settle(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant={pending.danger ? 'danger' : 'primary'}
            onClick={() => {
              settle(true);
            }}
          >
            {pending.confirmLabel}
          </Button>
        </>
      }
    >
      {pending.items && pending.items.length > 0 && (
        <ul className={styles.items} aria-label={t('confirm.effect')}>
          {pending.items.map((item) => (
            <li key={item.label} className={styles.item}>
              <span className={styles.itemLabel} title={item.label}>
                {item.label}
              </span>
              {item.note && (
                <span className={styles.itemNote} data-danger={item.danger === true}>
                  {item.note}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {pending.statement && <code className={styles.statement}>{pending.statement}</code>}
    </Dialog>
  );
}
