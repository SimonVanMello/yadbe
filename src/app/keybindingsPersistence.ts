import { ACTION_IDS } from './actions';
import { loadUiSlice, saveUiSlice } from './backendPreferences';
import { parseOverrides } from './keybindingsLogic';
import { useKeybindingsStore } from './keybindingsStore';

/** Version of the saved `keybindings` slice. */
const KEYBINDINGS_VERSION = 1;

const SAVE_DELAY_MS = 300;

/** Restores the saved shortcuts, then saves every change. Returns the unsubscribe function. */
export async function restoreAndPersistKeybindings(): Promise<() => void> {
  try {
    const saved = await loadUiSlice('keybindings');
    useKeybindingsStore.getState().hydrate(parseOverrides(saved, ACTION_IDS));
  } catch (error) {
    console.warn('Saved shortcuts unavailable, using the defaults', error);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = useKeybindingsStore.subscribe((state, previous) => {
    if (state.overrides === previous.overrides) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void saveUiSlice('keybindings', {
        version: KEYBINDINGS_VERSION,
        overrides: useKeybindingsStore.getState().overrides,
      });
    }, SAVE_DELAY_MS);
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
