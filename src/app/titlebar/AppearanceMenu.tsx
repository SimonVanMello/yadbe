import { useT } from '../../i18n/useT';
import { IconButton } from '../../ui/IconButton';
import { Popover } from '../../ui/Popover';
import { AppearanceControls } from '../AppearanceControls';

/** Title bar button for the theme and language switches, until the preferences screen (M2-8). */
export function AppearanceMenu() {
  const t = useT();
  return (
    <Popover trigger={<IconButton icon="settings" label={t('settings.title')} size="sm" />}>
      <AppearanceControls />
    </Popover>
  );
}
