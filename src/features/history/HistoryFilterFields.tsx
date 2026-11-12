import { useId } from 'react';

import { useT } from '../../i18n/useT';
import { Button } from '../../ui/Button';
import { Select, type SelectOption } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { useConnections } from '../connections/connectionStore';
import styles from './HistoryFilterFields.module.css';
import {
  DURATION_PRESETS,
  OUTCOMES,
  RANGE_PRESETS,
  activeFilterCount,
  type DurationPreset,
  type OutcomeFilter,
  type RangePreset,
} from './historyModel';
import { useHistoryUi } from './historyStore';

/** Connection, result, period and duration filters of the History panel (F-101). */
export function HistoryFilterFields() {
  const t = useT();
  const id = useId();
  const filters = useHistoryUi((state) => state.filters);
  const patch = useHistoryUi((state) => state.patchFilters);
  const reset = useHistoryUi((state) => state.resetFilters);
  const connections = useConnections();

  const connectionOptions: SelectOption<string>[] = [
    { value: '', label: t('history.filter.allConnections') },
    ...connections.map((connection) => ({ value: connection.id, label: connection.name })),
  ];
  const outcomeOptions: SelectOption<OutcomeFilter>[] = [
    { value: 'all', label: t('history.filter.allOutcomes') },
    ...OUTCOMES.map((outcome) => ({ value: outcome, label: t(`history.outcome.${outcome}`) })),
  ];
  const rangeOptions: SelectOption<RangePreset>[] = RANGE_PRESETS.map((range) => ({
    value: range,
    label: t(`history.range.${range}`),
  }));
  const durationOptions: SelectOption<DurationPreset>[] = DURATION_PRESETS.map((duration) => ({
    value: duration,
    label: t(`history.duration.${duration}`),
  }));

  return (
    <div className={styles.fields}>
      <div className={`${styles.field} ${styles.wide}`}>
        <label htmlFor={`${id}-connection`}>{t('history.filter.connection')}</label>
        <Select
          id={`${id}-connection`}
          value={filters.connectionId ?? ''}
          options={connectionOptions}
          onChange={(value) => {
            patch({ connectionId: value === '' ? null : value });
          }}
        />
      </div>
      <div className={styles.field}>
        <label htmlFor={`${id}-outcome`}>{t('history.filter.outcome')}</label>
        <Select
          id={`${id}-outcome`}
          value={filters.outcome}
          options={outcomeOptions}
          onChange={(outcome) => {
            patch({ outcome });
          }}
        />
      </div>
      <div className={styles.field}>
        <label htmlFor={`${id}-range`}>{t('history.filter.range')}</label>
        <Select
          id={`${id}-range`}
          value={filters.range}
          options={rangeOptions}
          onChange={(range) => {
            patch({ range });
          }}
        />
      </div>
      <div className={styles.field}>
        <label htmlFor={`${id}-duration`}>{t('history.filter.duration')}</label>
        <Select
          id={`${id}-duration`}
          value={filters.minDuration}
          options={durationOptions}
          onChange={(minDuration) => {
            patch({ minDuration });
          }}
        />
      </div>
      <div className={`${styles.field} ${styles.wide}`}>
        <Switch
          checked={filters.thisTab}
          onCheckedChange={(thisTab) => {
            patch({ thisTab });
          }}
          label={t('history.filter.thisTab')}
          hint={t('history.filter.thisTabHint')}
        />
      </div>
      <div className={styles.reset}>
        <Button
          size="sm"
          variant="ghost"
          disabled={activeFilterCount(filters) === 0}
          onClick={reset}
        >
          {t('history.filters.reset')}
        </Button>
      </div>
    </div>
  );
}
