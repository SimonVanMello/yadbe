import { useEffect, useRef } from 'react';

import { useT } from '../../i18n/useT';
import type { ViewFilterOp } from '../../ipc';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { TextInput } from '../../ui/TextInput';
import styles from './ResultFilterBar.module.css';
import { needsValue, operatorsFor, type ResultViewState } from './resultViewModel';
import { useResultViewStore } from './resultViewStore';
import type { GridColumn } from './rowSource';

const ALL = 'all';

interface ResultFilterBarProps {
  resultId: number;
  columns: readonly GridColumn[];
  view: ResultViewState;
}

/**
 * Filter of a result's loaded rows (F-065): conditions on one column or on every column, all
 * of which must hold. The backend applies them to the rows it keeps; the statement does not
 * run again.
 */
export function ResultFilterBar({ resultId, columns, view }: ResultFilterBarProps) {
  const t = useT();
  const store = useResultViewStore.getState;
  const kindOf = (column: number | null) =>
    column === null ? null : (columns[column]?.kind ?? null);
  const focusLast = useRef(false);
  const list = useRef<HTMLDivElement>(null);

  // A condition that was just added takes the keyboard.
  useEffect(() => {
    if (!focusLast.current) return;
    focusLast.current = false;
    const inputs = list.current?.querySelectorAll<HTMLInputElement>('input[data-value]');
    inputs?.[inputs.length - 1]?.focus();
  }, [view.conditions.length]);

  const add = () => {
    focusLast.current = true;
    store().addCondition(resultId, null);
  };

  return (
    <div className={styles.bar} role="search" aria-label={t('resultView.bar')}>
      <Icon name="filter" className={styles.icon} />
      <div ref={list} className={styles.conditions}>
        {view.conditions.map((condition) => {
          const kind = kindOf(condition.column);
          const operators = operatorsFor(kind);
          return (
            <div key={condition.id} className={styles.condition} data-condition="">
              <Select
                aria-label={t('resultView.column')}
                value={condition.column === null ? ALL : String(condition.column)}
                options={[
                  { value: ALL, label: t('resultView.column.all') },
                  ...columns.map((column, index) => ({
                    value: String(index),
                    label: column.name,
                  })),
                ]}
                onChange={(value) => {
                  store().updateCondition(
                    resultId,
                    condition.id,
                    { column: value === ALL ? null : Number(value) },
                    kindOf,
                  );
                }}
              />
              <Select<ViewFilterOp>
                aria-label={t('resultView.operator')}
                value={condition.op}
                options={operators.map((op) => ({ value: op, label: t(`resultView.op.${op}`) }))}
                onChange={(op) => {
                  store().updateCondition(resultId, condition.id, { op }, kindOf);
                }}
              />
              {needsValue(condition.op) && (
                <TextInput
                  data-value=""
                  className={styles.value}
                  aria-label={t('resultView.value')}
                  placeholder={t('resultView.value')}
                  value={condition.value}
                  onChange={(event) => {
                    store().updateCondition(
                      resultId,
                      condition.id,
                      { value: event.target.value },
                      kindOf,
                    );
                  }}
                />
              )}
              <IconButton
                icon="close"
                size="sm"
                label={t('resultView.remove')}
                onClick={() => {
                  store().removeCondition(resultId, condition.id);
                }}
              />
            </div>
          );
        })}
      </div>
      <Button size="sm" variant="ghost" onClick={add}>
        {t('resultView.add')}
      </Button>
      <span className={styles.spacer} />
      <Switch
        label={t('resultView.matchCase')}
        checked={view.matchCase}
        onCheckedChange={(checked) => {
          store().setMatchCase(resultId, checked);
        }}
      />
      <Button
        size="sm"
        variant="ghost"
        disabled={view.conditions.length === 0 && view.sort.length === 0}
        onClick={() => {
          store().clear(resultId);
        }}
      >
        {t('resultView.clear')}
      </Button>
      <IconButton
        icon="close"
        size="sm"
        label={t('resultView.close')}
        onClick={() => {
          store().setBar(resultId, false);
        }}
      />
    </div>
  );
}
