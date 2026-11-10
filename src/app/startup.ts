import { startConnectionFeed } from '../features/connections/connectionStore';
import { startMetaFeed } from '../features/explorer/metaFeed';
import { startStatementLogFeed } from '../features/statement-log/statementLogStore';
import { initI18n, translate, useI18nStore } from '../i18n/i18n';
import { ipc, unwrap } from '../ipc';
import { initTheme } from '../theme/themeStore';
import { loadPreferences } from './backendPreferences';
import { restoreAndPersistLayout } from './layout/layoutStore';
import { applyStoredPreferences } from './preferences';
import { fromBackendTabs, toBackendTabs } from './tabs/tabsPersistence';
import { toSavedTabs, useTabsStore } from './tabs/tabsStore';

/**
 * Whether the saved tabs were read: a session started on a failed read must not overwrite the
 * stored one (the next launch would restore a single welcome tab instead of it).
 */
let tabsHydrated = false;

/** Exported for the tests: `startup()` runs it once. */
export async function restoreTabs(): Promise<void> {
  try {
    const saved = fromBackendTabs(await unwrap(ipc.commands.loadTabs()));
    if (saved) useTabsStore.getState().hydrate(saved);
    tabsHydrated = true;
  } catch (error) {
    console.warn('Saved tabs unavailable, starting with a new tab', error);
  }
}

/** Saves run one after the other, each with the tabs as they are when it starts. */
let tabsSaving: Promise<void> = Promise.resolve();
let tabsSaveWarned = false;

function saveTabsNow(): void {
  tabsSaving = tabsSaving
    .then(async () => {
      const { locale } = useI18nStore.getState();
      const state = toBackendTabs(toSavedTabs(useTabsStore.getState()), (number) =>
        translate(locale, 'tab.query', { number }),
      );
      const result = await ipc.commands.saveTabs(state);
      if (result.status === 'error' && !tabsSaveWarned) {
        tabsSaveWarned = true;
        console.warn('Tabs could not be saved', result.error);
      }
    })
    .catch((error: unknown) => {
      console.warn('Tabs could not be saved', error);
    });
}

/** Saves the tabs after every change (F-122: tabs are restored on restart). */
export function persistTabs(): () => void {
  return useTabsStore.subscribe((state, previous) => {
    if (state.tabs === previous.tabs && state.activeTabId === previous.activeTabId) return;
    if (!tabsHydrated) return;
    saveTabsNow();
  });
}

/** Tests only: forgets the hydration state. */
export function resetTabsPersistence({ hydrated = false }: { hydrated?: boolean } = {}): void {
  tabsHydrated = hydrated;
  tabsSaving = Promise.resolve();
}

/** The backend's preferences win over the copy kept for the first paint (see `preferences.ts`). */
async function restorePreferences(): Promise<void> {
  try {
    const preferences = await loadPreferences();
    applyStoredPreferences(preferences);
    initTheme(preferences.theme);
    initI18n(preferences.locale);
  } catch (error) {
    console.warn('Saved preferences unavailable, keeping the local ones', error);
  }
}

let started: Promise<void> | undefined;

/** Runs once per app launch (idempotent under React StrictMode). */
export function startup(): Promise<void> {
  started ??= (async () => {
    void startConnectionFeed();
    void startStatementLogFeed();
    startMetaFeed();
    await restorePreferences();
    await Promise.all([restoreAndPersistLayout(), restoreTabs()]);
    persistTabs();
  })();
  return started;
}
