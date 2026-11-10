import { ipc, unwrap, type Preferences } from '../ipc';

/**
 * The backend keeps the preferences as one record, saved whole: reads are cached and writes run
 * one after the other, each on top of the previous result, so two features saving at the same
 * time (theme, panel sizes) never overwrite each other.
 */
let current: Preferences | null = null;
let queue: Promise<unknown> = Promise.resolve();

export async function loadPreferences(): Promise<Preferences> {
  current ??= await unwrap(ipc.commands.getPreferences());
  return current;
}

/** Applies `change` to the latest preferences and saves the result. Never rejects. */
export function updatePreferences(
  change: (preferences: Preferences) => Preferences,
): Promise<void> {
  const run = queue.then(async () => {
    const next = change(await loadPreferences());
    current = await unwrap(ipc.commands.setPreferences(next));
  });
  queue = run.catch((error: unknown) => {
    console.warn('Preferences could not be saved', error);
  });
  return queue.then(() => undefined);
}

/** Tests only: forgets the cached preferences. */
export function resetBackendPreferences(): void {
  current = null;
  queue = Promise.resolve();
}

function parseSlices(uiState: string | null): Record<string, unknown> {
  if (!uiState) return {};
  try {
    const value: unknown = JSON.parse(uiState);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** One slice of the frontend-owned `uiState` (panel sizes…), `undefined` when absent. */
export async function loadUiSlice(name: string): Promise<unknown> {
  return parseSlices((await loadPreferences()).uiState)[name];
}

/** Replaces one slice of `uiState`, keeping the others. */
export function saveUiSlice(name: string, value: unknown): Promise<void> {
  return updatePreferences((preferences) => ({
    ...preferences,
    uiState: JSON.stringify({ ...parseSlices(preferences.uiState), [name]: value }),
  }));
}
