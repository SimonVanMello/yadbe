import { useT } from '../../../i18n/useT';
import { themeForMode } from '../../../theme/catalog';
import { useThemeStore } from '../../../theme/themeStore';
import { ThemeSwatch } from './ThemeSwatch';
import styles from './ThemeGallery.module.css';

/** While the theme follows the OS: the theme of each mode, the one in use marked. */
export function ThemeSlots() {
  const t = useT();
  const lightTheme = useThemeStore((state) => state.lightTheme);
  const darkTheme = useThemeStore((state) => state.darkTheme);
  const resolved = useThemeStore((state) => state.resolved);
  const slots = [
    {
      dark: false,
      label: t('preferences.theme.slot.light'),
      theme: themeForMode(lightTheme, false),
    },
    { dark: true, label: t('preferences.theme.slot.dark'), theme: themeForMode(darkTheme, true) },
  ];
  return (
    <div className={styles.slotsBlock}>
      <div className={styles.slots}>
        {slots.map(({ dark, label, theme }) => {
          const inUse = theme.id === resolved;
          return (
            <div key={String(dark)} className={styles.slot} data-in-use={inUse ? '' : undefined}>
              <ThemeSwatch theme={theme.id} size="sm" />
              <span className={styles.slotText}>
                <span className={styles.slotLabel}>
                  {inUse ? `${label} · ${t('preferences.theme.slot.inUse')}` : label}
                </span>
                <span className={styles.slotName}>{theme.name}</span>
              </span>
            </div>
          );
        })}
      </div>
      <p className={styles.hint}>{t('preferences.theme.slots.hint')}</p>
    </div>
  );
}
