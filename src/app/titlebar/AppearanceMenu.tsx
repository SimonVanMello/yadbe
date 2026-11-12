import { useT } from '../../i18n/useT';
import { IconButton } from '../../ui/IconButton';
import { useShortcutOf } from '../useShortcutOf';
import { useShellStore } from '../shellStore';

/** Title bar gear: opens the preferences screen (F-125). */
export function AppearanceMenu() {
  const shortcutOf = useShortcutOf();
  const t = useT();
  return (
    <IconButton
      icon="settings"
      label={t('preferences.open')}
      shortcut={shortcutOf('preferences.open')}
      size="sm"
      onClick={() => {
        useShellStore.getState().openPreferences();
      }}
    />
  );
}
