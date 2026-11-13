import { useEffect } from 'react';

import { useT } from '../../i18n/useT';
import { Switch } from '../../ui/Switch';
import { loadUpdateStatus } from '../updates/updates';
import { useUpdateStore } from '../updates/updateStore';
import { setPreference, usePreference } from './preferenceStore';
import styles from './SettingRow.module.css';

/**
 * The opt-in update check at startup (F-127). `ask` (never answered) reads as off. A build
 * without the updater key cannot check: the switch is off and disabled, and says why.
 */
export function UpdatesSetting({ label, hint }: { label: string; hint: string }) {
  const t = useT();
  const value = usePreference('checkUpdates');
  const status = useUpdateStore((state) => state.status);
  useEffect(() => {
    if (!status) void loadUpdateStatus();
  }, [status]);
  const configured = status?.configured === true;
  return (
    <div className={styles.toggle}>
      <Switch
        label={label}
        hint={configured || !status ? hint : t('preferences.checkUpdates.notConfigured')}
        checked={configured && value === 'on'}
        disabled={!configured}
        onCheckedChange={(checked) => {
          setPreference('checkUpdates', checked ? 'on' : 'off');
        }}
      />
    </div>
  );
}
