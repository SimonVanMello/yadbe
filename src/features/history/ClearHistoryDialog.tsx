import { useId, useMemo, useState } from 'react';

import { showError } from '../../app/errors/presentError';
import { useT } from '../../i18n/useT';
import { ipc, unwrap } from '../../ipc';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Field } from '../../ui/Field';
import { Select, type SelectOption } from '../../ui/Select';
import { toast } from '../../ui/toastStore';
import { useConnections } from '../connections/connectionStore';
import styles from './ClearHistoryDialog.module.css';
import { CLEAR_RANGES, clearScope, type ClearRange } from './historyModel';
import { useHistoryUi } from './historyStore';
import { refreshHistory, useHistoryCount } from './useHistory';

interface ClearHistoryDialogProps {
  onClose: () => void;
}

/**
 * Clears the history: all of it, one connection's, or a period's (F-104). The confirmation says
 * how many entries go; nothing is deleted before it.
 */
export function ClearHistoryDialog({ onClose }: ClearHistoryDialogProps) {
  const t = useT();
  const id = useId();
  const connections = useConnections();
  const [connectionId, setConnectionId] = useState<string | null>(
    () => useHistoryUi.getState().filters.connectionId,
  );
  const [range, setRange] = useState<ClearRange>('any');
  const [clearing, setClearing] = useState(false);
  // The dialog's clock: the bounds do not move while it is open.
  const [openedAt] = useState(() => Date.now());
  const scope = useMemo(
    () => clearScope(connectionId, range, openedAt),
    [connectionId, range, openedAt],
  );
  const count = useHistoryCount(scope);
  const total = count.data ?? 0;

  const connectionOptions: SelectOption<string>[] = [
    { value: '', label: t('history.filter.allConnections') },
    ...connections.map((connection) => ({ value: connection.id, label: connection.name })),
  ];
  const rangeOptions: SelectOption<ClearRange>[] = CLEAR_RANGES.map((value) => ({
    value,
    label: t(`history.clear.range.${value}`),
  }));

  const clear = async () => {
    setClearing(true);
    try {
      const removed = await unwrap(ipc.commands.clearHistory(scope));
      useHistoryUi.getState().select(null);
      await refreshHistory();
      toast({ variant: 'success', title: t('history.cleared', { count: removed }) });
      onClose();
    } catch (error) {
      showError(error, { title: t('history.clear.failed') });
      setClearing(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('history.clear.title')}
      description={t('history.clear.description')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={total === 0 || clearing}
            onClick={() => {
              void clear();
            }}
          >
            {t('history.clear.confirm', { count: total })}
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <Field label={t('history.clear.connection')} htmlFor={`${id}-connection`}>
          <Select
            id={`${id}-connection`}
            value={connectionId ?? ''}
            options={connectionOptions}
            onChange={(value) => {
              setConnectionId(value === '' ? null : value);
            }}
          />
        </Field>
        <Field label={t('history.clear.period')} htmlFor={`${id}-range`}>
          <Select id={`${id}-range`} value={range} options={rangeOptions} onChange={setRange} />
        </Field>
        <p className={styles.effect} data-empty={total === 0 || undefined} aria-live="polite">
          {count.isPending
            ? ' '
            : total === 0
              ? t('history.clear.nothing')
              : t('history.clear.effect', { count: total })}
        </p>
      </div>
    </Dialog>
  );
}
