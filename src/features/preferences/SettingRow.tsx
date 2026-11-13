import { useId, type ReactNode } from 'react';

import { useT } from '../../i18n/useT';
import { IconButton } from '../../ui/IconButton';
import { Switch } from '../../ui/Switch';
import { CustomSetting } from './CustomSetting';
import type { PreferenceKey } from './preferenceSchema';
import { resetPreference, setPreference, usePreference } from './preferenceStore';
import { SettingControl } from './SettingControl';
import styles from './SettingRow.module.css';
import type { SettingSpec } from './settingsIndex';
import { useIsDefault } from './useSetting';

function ResetButton({ preferenceKey, label }: { preferenceKey: PreferenceKey; label: string }) {
  const t = useT();
  const isDefault = useIsDefault(preferenceKey);
  return (
    <span className={styles.reset}>
      {!isDefault && (
        <IconButton
          icon="retry"
          size="sm"
          label={t('preferences.reset.setting', { name: label })}
          onClick={() => {
            resetPreference(preferenceKey);
          }}
        />
      )}
    </span>
  );
}

function ToggleRow({
  preferenceKey,
  label,
  hint,
}: {
  preferenceKey: PreferenceKey;
  label: string;
  hint: string;
}) {
  const value = usePreference(preferenceKey);
  return (
    <>
      <div className={styles.toggle}>
        <Switch
          label={label}
          hint={hint}
          checked={value === true}
          onCheckedChange={(checked) => {
            (setPreference as (key: PreferenceKey, value: unknown) => void)(preferenceKey, checked);
          }}
        />
      </div>
      <ResetButton preferenceKey={preferenceKey} label={label} />
    </>
  );
}

function Frame({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div className={styles.row} data-setting={id}>
      {children}
    </div>
  );
}

/** One setting: its name and one-line description, the control, and a reset to default. */
export function SettingRow({ spec }: { spec: SettingSpec }) {
  const t = useT();
  const id = useId();
  const label = t(`preferences.setting.${spec.id}`);
  const hint = t(`preferences.setting.${spec.id}.hint`);

  if (spec.key === null || spec.control.type === 'custom') {
    return (
      <Frame id={spec.id}>
        <CustomSetting id={spec.id} label={label} hint={hint} />
      </Frame>
    );
  }
  if (spec.control.type === 'toggle') {
    return (
      <Frame id={spec.id}>
        <ToggleRow preferenceKey={spec.key} label={label} hint={hint} />
      </Frame>
    );
  }
  return (
    <Frame id={spec.id}>
      <div className={styles.text}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        <span id={`${id}-hint`} className={styles.hint}>
          {hint}
        </span>
      </div>
      <div className={styles.control}>
        <SettingControl
          preferenceKey={spec.key}
          control={spec.control}
          label={label}
          id={id}
          describedBy={`${id}-hint`}
        />
      </div>
      <ResetButton preferenceKey={spec.key} label={label} />
    </Frame>
  );
}
