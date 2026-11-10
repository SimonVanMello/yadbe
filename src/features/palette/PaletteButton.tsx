import { shortcutOf } from '../../app/actions';
import { useT } from '../../i18n/useT';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { ariaKeyShortcuts } from '../../ui/shortcuts';
import styles from './PaletteButton.module.css';
import { usePaletteStore } from './paletteStore';

/** Title bar button that opens the palette, with the shortcut hint. */
export function PaletteButton() {
  const t = useT();
  const shortcut = shortcutOf('palette.open');
  return (
    <button
      type="button"
      className={styles.button}
      aria-label={t('palette.button')}
      aria-keyshortcuts={ariaKeyShortcuts(shortcut)}
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
