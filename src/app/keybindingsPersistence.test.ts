import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockBackend } from '../ipc/mockClient';
import { loadUiSlice, resetBackendPreferences, saveUiSlice } from './backendPreferences';
import { restoreAndPersistKeybindings } from './keybindingsPersistence';
import { useKeybindingsStore } from './keybindingsStore';

beforeEach(() => {
  mockBackend.reset();
  resetBackendPreferences();
  useKeybindingsStore.getState().resetAll();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('keybindings persistence', () => {
  it('restores the saved shortcuts and ignores unknown actions', async () => {
    await saveUiSlice('keybindings', {
      version: 1,
      overrides: { 'tab.new': 'Mod+Alt+N', 'tab.close': null, 'gone.action': 'Mod+Q' },
    });
    const stop = await restoreAndPersistKeybindings();
    expect(useKeybindingsStore.getState().overrides).toEqual({
      'tab.new': 'Mod+Alt+N',
      'tab.close': null,
    });
    stop();
  });

  it('saves a change after a short quiet', async () => {
    const stop = await restoreAndPersistKeybindings();
    vi.useFakeTimers();
    useKeybindingsStore.getState().set('query.run', 'Mod+Alt+R');
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();
    expect(await loadUiSlice('keybindings')).toEqual({
      version: 1,
      overrides: { 'query.run': 'Mod+Alt+R' },
    });
    stop();
  });
});
