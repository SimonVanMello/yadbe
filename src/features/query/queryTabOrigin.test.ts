import { describe, expect, it } from 'vitest';

import { editorFromSaved, editorToSaved } from './queryTabPersistence';
import {
  createQueryTabStore,
  differsFromSaved,
  isDirty,
  newQueryTabState,
  type QueryTabState,
} from './queryTabStore';

function editor(patch: Partial<QueryTabState>): QueryTabState {
  return { ...newQueryTabState(), ...patch };
}

describe('the saved query a tab comes from (F-050)', () => {
  it('differs only once the text is not the baseline any more, or when there is none', () => {
    const store = createQueryTabStore();
    store.getState().ensure('t', editor({ content: 'select 1;' }));
    const state = () => store.getState().tabs['t'] ?? newQueryTabState();
    expect(differsFromSaved(state())).toBe(false);
    store.getState().setOrigin('t', { queryId: 'q', baseline: 'select 1;' });
    expect(differsFromSaved(state())).toBe(false);
    store.getState().setContent('t', 'select 2;');
    expect(differsFromSaved(state())).toBe(true);
    // The file-save mark is another thing: this tab is not bound to a file.
    expect(isDirty(state())).toBe(true);
    expect(state().filePath).toBeNull();
    store.getState().setOrigin('t', { queryId: 'q', baseline: 'select 2;' });
    expect(differsFromSaved(state())).toBe(false);
    store.getState().setOrigin('t', { queryId: 'q', baseline: null });
    expect(differsFromSaved(state())).toBe(true);
    store.getState().setOrigin('t', null);
    expect(differsFromSaved(state())).toBe(false);
  });

  it('survives a restart; a tab with changes comes back without a baseline', () => {
    const same = editorToSaved(
      editor({ content: 'select 1;', origin: { queryId: 'q1', baseline: 'select 1;' } }),
    );
    expect(same.ui).toMatchObject({ origin: { id: 'q1', differs: false } });
    const back = editorFromSaved({ ...same, uiState: JSON.stringify(same.ui) });
    expect(back.origin).toEqual({ queryId: 'q1', baseline: 'select 1;' });
    expect(differsFromSaved(back)).toBe(false);

    const changed = editorToSaved(
      editor({ content: 'select 2;', origin: { queryId: 'q1', baseline: 'select 1;' } }),
    );
    expect(changed.ui).toMatchObject({ origin: { id: 'q1', differs: true } });
    const restored = editorFromSaved({ ...changed, uiState: JSON.stringify(changed.ui) });
    expect(restored.origin).toEqual({ queryId: 'q1', baseline: null });
    expect(differsFromSaved(restored)).toBe(true);
  });

  it('is not remembered by a plain tab, nor read from a damaged uiState', () => {
    const plain = editorToSaved(editor({ content: 'select 1;' }));
    expect(plain.ui).not.toHaveProperty('origin');
    const damaged = [JSON.stringify({ origin: 'x' }), JSON.stringify({ origin: {} }), '{', null];
    for (const uiState of damaged) {
      expect(editorFromSaved({ ...plain, uiState }).origin).toBeNull();
    }
  });
});
