import { formatNumber, useI18nStore } from '../../i18n/i18n';
import { useT } from '../../i18n/useT';
import type { DangerReport } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';

interface DangerDialogProps {
  danger: DangerReport | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The confirmation of a dangerous document command (rule 10): what it is and what it would
 * touch, as the server counts it now. Nothing was sent; it runs only on "Run it".
 */
export function DangerDialog({ danger, onConfirm, onCancel }: DangerDialogProps) {
  const t = useT();
  const locale = useI18nStore((state) => state.locale);
  if (!danger) return null;
  const target = danger.collection ? `${danger.database}.${danger.collection}` : danger.database;
  const effect =
    danger.kind === 'dropDatabase'
      ? danger.collections === null
        ? t('mongo.danger.dropDatabase.unknown', { target })
        : t('mongo.danger.dropDatabase', {
            target,
            count: formatNumber(locale, danger.collections),
          })
      : danger.documents === null
        ? t(`mongo.danger.${danger.kind}.unknown`, { target })
        : t(`mongo.danger.${danger.kind}`, {
            target,
            count: formatNumber(locale, danger.documents),
          });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t('mongo.danger.title', { command: danger.command })}
      description={effect}
      footer={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="danger" onClick={onConfirm} data-testid="danger-confirm">
            {t('mongo.danger.run')}
          </Button>
        </>
      }
    />
  );
}
