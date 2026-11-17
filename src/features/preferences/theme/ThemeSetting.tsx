import { ThemeGallery } from './ThemeGallery';
import styles from './ThemeSetting.module.css';

/** The color theme setting: its name and description over the gallery, the row's full width. */
export function ThemeSetting({ label, hint }: { label: string; hint: string }) {
  return (
    <div className={styles.setting}>
      <div className={styles.heading}>
        <span className={styles.label}>{label}</span>
        <span className={styles.hint}>{hint}</span>
      </div>
      <ThemeGallery />
    </div>
  );
}
