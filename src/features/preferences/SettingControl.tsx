import type { KeyboardEvent } from 'react';

import { useT } from '../../i18n/useT';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Select } from '../../ui/Select';
import { TextInput } from '../../ui/TextInput';
import {
  DEFINITIONS,
  normalize,
  type NumberDefinition,
  type PreferenceKey,
} from './preferenceSchema';
import { setPreference, usePreference } from './preferenceStore';
import styles from './SettingControl.module.css';
import { optionLabel, type ControlSpec } from './settingsIndex';

interface SettingControlProps {
  preferenceKey: PreferenceKey;
  control: ControlSpec;
  /** Accessible name of the control. */
  label: string;
  /** `id` of the input, for the row's `<label>`. */
  id: string;
  describedBy: string;
}

/** Writes `value` as the setting; a number or text control commits on Enter and on blur. */
function commit(key: PreferenceKey, value: unknown): unknown {
  const next = normalize(key, value);
  // `normalize` yields the key's own type; the store checks it again.
  (setPreference as (key: PreferenceKey, value: unknown) => void)(key, next);
  return next;
}

function numberBounds(key: PreferenceKey): { min: number; max: number } | null {
  const definition = DEFINITIONS[key] as Partial<NumberDefinition>;
  return typeof definition.min === 'number' && typeof definition.max === 'number'
    ? { min: definition.min, max: definition.max }
    : null;
}

/** The editor of one setting, by the kind of control its spec asks for. */
export function SettingControl({
  preferenceKey: key,
  control,
  label,
  id,
  describedBy,
}: SettingControlProps) {
  const t = useT();
  const value = usePreference(key);

  if (control.type === 'segmented') {
    return (
      <SegmentedControl
        label={label}
        value={String(value)}
        options={control.options.map((option) => ({
          value: option.value,
          label: optionLabel(option, t),
        }))}
        onChange={(next) => {
          commit(key, typeof value === 'number' ? Number(next) : next);
        }}
      />
    );
  }

  if (control.type === 'select') {
    return (
      <Select
        id={id}
        aria-describedby={describedBy}
        className={styles.select}
        value={String(value)}
        options={control.options.map((option) => ({
          value: option.value,
          label: optionLabel(option, t),
        }))}
        onChange={(next) => {
          commit(key, typeof value === 'number' ? Number(next) : next);
        }}
      />
    );
  }

  if (control.type === 'number') {
    const bounds = numberBounds(key);
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') event.currentTarget.blur();
    };
    return (
      <span className={styles.numberField}>
        <span className={styles.numberBox}>
          <TextInput
            id={id}
            // Remounted when the value changes (reset), so the field never shows a stale draft.
            key={String(value)}
            type="number"
            aria-describedby={describedBy}
            defaultValue={String(value)}
            min={bounds?.min}
            max={bounds?.max}
            onKeyDown={onKeyDown}
            onBlur={(event) => {
              const typed = event.currentTarget.valueAsNumber;
              const next = Number.isNaN(typed) ? value : commit(key, typed);
              event.currentTarget.value = String(next);
            }}
          />
        </span>
        {control.unit && <span className={styles.unit}>{t(control.unit)}</span>}
      </span>
    );
  }

  if (control.type === 'text') {
    return (
      <span className={styles.textBox}>
        <TextInput
          id={id}
          key={String(value)}
          mono={control.mono}
          aria-describedby={describedBy}
          defaultValue={String(value)}
          placeholder={control.placeholder ? t(control.placeholder) : undefined}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          onBlur={(event) => {
            const typed = event.currentTarget.value;
            const parsed = DEFINITIONS[key].parse(typed);
            // Invalid text (or an empty NULL label) is refused: the field shows what is in effect.
            if (parsed === undefined) {
              event.currentTarget.value = String(value);
              return;
            }
            event.currentTarget.value = String(commit(key, parsed));
          }}
        />
      </span>
    );
  }

  return null;
}
