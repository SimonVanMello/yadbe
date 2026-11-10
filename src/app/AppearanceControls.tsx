import { locales, useI18nStore, type Locale } from '../i18n/i18n';
import { useT } from '../i18n/useT';
import { useThemeStore, type ThemePreference } from '../theme/themeStore';
import { SegmentedControl } from '../ui/SegmentedControl';
import styles from './AppearanceControls.module.css';

const LOCALE_LABELS: Record<Locale, string> = { en: 'English', fr: 'Français' };

/** Theme (light / dark / system) and language switches. */
export function AppearanceControls() {
  const t = useT();
  const preference = useThemeStore((state) => state.preference);
  const setPreference = useThemeStore((state) => state.setPreference);
  const locale = useI18nStore((state) => state.locale);
  const setLocale = useI18nStore((state) => state.setLocale);

  const themeOptions: { value: ThemePreference; label: string }[] = [
    { value: 'light', label: t('settings.theme.light') },
    { value: 'dark', label: t('settings.theme.dark') },
    { value: 'system', label: t('settings.theme.system') },
  ];
  const localeOptions = locales.map((value) => ({ value, label: LOCALE_LABELS[value] }));

  return (
    <div className={styles.controls}>
      <div className={styles.setting}>
        {t('settings.theme')}
        <SegmentedControl
          label={t('settings.theme')}
          value={preference}
          options={themeOptions}
          onChange={setPreference}
        />
      </div>
      <div className={styles.setting}>
        {t('settings.language')}
        <SegmentedControl
          label={t('settings.language')}
          value={locale}
          options={localeOptions}
          onChange={setLocale}
        />
      </div>
    </div>
  );
}
