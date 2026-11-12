import { useShortcutOf } from '../../app/useShortcutOf';
import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { ariaKeyShortcuts } from '../../ui/shortcuts';
import styles from './PaletteButton.module.css';
import { usePaletteStore } from './paletteStore';

/** Title bar button that opens the palette, with the shortcut hint. */
export function PaletteButton() {
  const shortcutOf = useShortcutOf();
  const t = useT();
  const shortcut = shortcutOf('palette.open');
  return (
    <button
      type="button"
      className={styles.button}
      aria-label={t('palette.button')}
      aria-keyshortcuts={shortcut ? ariaKeyShortcuts(shortcut) : undefined}
      onClick={() => {
        usePaletteStore.getState().show();
      }}
    >
      <Icon name="search" />
      <span className={styles.text}>{t('palette.buttonText')}</span>
      <Kbd shortcut={shortcut} />
    </button>
  );
}
