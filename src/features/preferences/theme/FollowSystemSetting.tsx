import { useThemeStore } from '../../../theme/themeStore';
import { Switch } from '../../../ui/Switch';
import styles from '../SettingRow.module.css';

/** Follow the OS: one theme for the light mode, one for the dark mode. */
export function FollowSystemSetting({ label, hint }: { label: string; hint: string }) {
  const preference = useThemeStore((state) => state.preference);
  return (
    <div className={styles.toggle}>
      <Switch
        checked={preference === 'system'}
        label={label}
        hint={hint}
        onCheckedChange={(follow) => {
          // Turning it off keeps the theme on screen: the mode the OS is in right now.
          const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
          useThemeStore.getState().setPreference(follow ? 'system' : dark ? 'dark' : 'light');
        }}
      />
    </div>
  );
}
