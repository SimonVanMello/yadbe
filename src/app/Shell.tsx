import { useT } from '../i18n/useT';
import { Icon } from '../ui/Icon';
import { AppearanceControls } from './AppearanceControls';
import styles from './Shell.module.css';
import { useAppInfo } from './useAppInfo';

/** Minimal window: app name and version from the backend, appearance switches. M0-3 builds the real shell. */
export function Shell() {
  const t = useT();
  const appInfo = useAppInfo();

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <AppearanceControls />
      </header>
      <main className={styles.main}>
        <Icon name="database" size="lg" className={styles.logo} />
        <h1 className={styles.name}>{t('app.name')}</h1>
        <p className={styles.tagline}>{t('app.tagline')}</p>
        <p className={styles.version} data-testid="app-info">
          {appInfo.data
            ? t('app.version', {
                appVersion: appInfo.data.appVersion,
                os: appInfo.data.os,
                arch: appInfo.data.arch,
              })
            : appInfo.isError
              ? t('app.loadError')
              : t('app.loading')}
        </p>
        <a className={styles.link} href="#primitives">
          {t('app.primitivesLink')}
        </a>
      </main>
    </div>
  );
}
