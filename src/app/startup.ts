import { restoreAndPersistExportPrefs } from '../features/export/exportStore';
import { startExportFeed } from '../features/export/runExport';
import { startConnectionFeed } from '../features/connections/connectionStore';
import { startMetaFeed } from '../features/explorer/metaFeed';
import { restoreAndPersistPreferences } from '../features/preferences/preferenceStore';
import { restoreAndPersistQueryUi, startQueryFeature } from '../features/query/queryFeature';
import { useQueryTabStore } from '../features/query/queryTabStore';
import { startStatementLogFeed } from '../features/statement-log/statementLogStore';
import { startObjectsFeature } from '../features/objects/objectsFeature';
import { startTableDataFeature } from '../features/table-data/tableFeature';
import { useTableTabStore } from '../features/table-data/tableTabStore';
import { initI18n, translate, useI18nStore } from '../i18n/i18n';
import { ipc, unwrap } from '../ipc';
import { initTheme } from '../theme/themeStore';
import { loadPreferences } from './backendPreferences';
import { restoreAndPersistKeybindings } from './keybindingsPersistence';
import { restoreAndPersistLayout } from './layout/layoutStore';
import { applyStoredPreferences } from './preferences';
import {
  editorsFromBackendTabs,
  fromBackendTabs,
  tablesFromBackendTabs,
  toBackendTabs,
} from './tabs/tabsPersistence';
import { toSavedTabs, useTabsStore } from './tabs/tabsStore';

/**
 * Whether the saved tabs were read: a session started on a failed read must not overwrite the
 * stored one (the next launch would restore a single welcome tab instead of it).
 */
let tabsHydrated = false;

/** Exported for the tests: `startup()` runs it once. */
export async function restoreTabs(): Promise<void> {
  try {
    const backend = await unwrap(ipc.commands.loadTabs());
    const saved = fromBackendTabs(backend);
    if (saved) {
      // The editors first: a tab never shows before its text is there.
      useQueryTabStore.getState().hydrate(editorsFromBackendTabs(backend));
      useTableTabStore.getState().hydrate(tablesFromBackendTabs(backend));
      useTabsStore.getState().hydrate(saved);
    }
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
      const state = toBackendTabs(
        toSavedTabs(useTabsStore.getState()),
        (number) => translate(locale, 'tab.query', { number }),
        useQueryTabStore.getState().tabs,
        useTableTabStore.getState().tabs,
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

/** Typing, cursor moves and scrolling are saved after this much quiet (F-044: autosave). */
const EDITOR_AUTOSAVE_MS = 1500;

/**
 * Saves the tabs after every change (F-122: tabs are restored on restart): at once when the tabs
 * themselves change (opening, closing or switching flushes what was typed), and a moment after
 * the last keystroke, cursor move or scroll in an editor.
 */
export function persistTabs(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    if (tabsHydrated) saveTabsNow();
  };
  const offTabs = useTabsStore.subscribe((state, previous) => {
    if (state.tabs === previous.tabs && state.activeTabId === previous.activeTabId) return;
    if (!tabsHydrated) return;
    clearTimeout(timer);
    timer = undefined;
    saveTabsNow();
  });
  const offEditors = useQueryTabStore.subscribe((state, previous) => {
    if (state.tabs === previous.tabs || !tabsHydrated) return;
    clearTimeout(timer);
    timer = setTimeout(flush, EDITOR_AUTOSAVE_MS);
  });
  // A table tab's filter, sort, page size and column widths.
  const offTables = useTableTabStore.subscribe((state, previous) => {
    if (state.tabs === previous.tabs || !tabsHydrated) return;
    clearTimeout(timer);
    timer = setTimeout(flush, EDITOR_AUTOSAVE_MS);
  });
  // A hidden window may be about to close: do not hold the last keystrokes back.
  const onHidden = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', flush);
  return () => {
    offTabs();
    offEditors();
    offTables();
    document.removeEventListener('visibilitychange', onHidden);
    window.removeEventListener('pagehide', flush);
    clearTimeout(timer);
  };
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
    startQueryFeature();
    startTableDataFeature();
    startObjectsFeature();
    startExportFeed();
    await restorePreferences();
    await Promise.all([
      restoreAndPersistLayout(),
      restoreTabs(),
      restoreAndPersistQueryUi(),
      restoreAndPersistExportPrefs(),
      restoreAndPersistPreferences(),
      restoreAndPersistKeybindings(),
    ]);
    persistTabs();
  })();
  return started;
}
