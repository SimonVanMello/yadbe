import { describe, expect, it, vi } from 'vitest';

import {
  editorsFromBackendTabs,
  fromBackendTabs,
  toBackendTabs,
} from '../../app/tabs/tabsPersistence';
import {
  MAX_SAVED_CONTENT_BYTES,
  editorFromSaved,
  editorToSaved,
  fitsInStore,
} from './queryTabPersistence';
import { hashText, isDirty, newQueryTabState, type QueryTabState } from './queryTabStore';

const title = (ordinal: number) => `Query ${String(ordinal)}`;

function editor(patch: Partial<QueryTabState>): QueryTabState {
  return { ...newQueryTabState(), ...patch };
}

describe('saving an editor', () => {
  it('stores the text, cursor, database and scroll of a scratch tab', () => {
    const saved = editorToSaved(
      editor({
        content: 'select 1;',
        savedContent: '',
        selection: { anchor: 2, head: 4 },
        database: 'analytics',
        scrollTop: 40,
        scrollLeft: 3,
      }),
    );
    expect(saved).toMatchObject({
      content: 'select 1;',
      cursor: { anchor: 2, head: 4 },
      database: 'analytics',
      filePath: null,
    });
    expect(saved.ui).toEqual({ scroll: [40, 3] });
  });

  it('keeps what is needed to tell a file-bound tab from its file', () => {
    const saved = editorToSaved(
      editor({
        content: 'select 2;',
        savedContent: 'select 1;',
        filePath: '/q/a.sql',
        fileHash: hashText('select 1;'),
      }),
    );
    expect(saved.filePath).toBe('/q/a.sql');
    expect(saved.ui).toMatchObject({ fileHash: hashText('select 1;'), dirty: true });
  });

  it('saves an oversized tab empty instead of making the whole save fail', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const huge = 'x'.repeat(MAX_SAVED_CONTENT_BYTES + 1);
    expect(fitsInStore(huge)).toBe(false);
    expect(editorToSaved(editor({ content: huge })).content).toBe('');
    expect(fitsInStore('select 1')).toBe(true);
    warn.mockRestore();
  });
});

describe('restoring an editor', () => {
  it('round-trips a scratch tab: it is dirty as long as it holds text', () => {
    const original = editor({
      content: 'select 1;',
      savedContent: '',
      selection: { anchor: 3, head: 3 },
      scrollTop: 12,
    });
    const saved = editorToSaved(original);
    const back = editorFromSaved({ ...saved, uiState: JSON.stringify(saved.ui) });
    expect(back).toMatchObject({
      content: 'select 1;',
      selection: { anchor: 3, head: 3 },
      scrollTop: 12,
      filePath: null,
    });
    expect(isDirty(back)).toBe(true);
  });

  it('restores a clean file tab clean, and an edited one dirty with no baseline', () => {
    const clean = editorToSaved(
      editor({ content: 'a', savedContent: 'a', filePath: '/q/a.sql', fileHash: hashText('a') }),
    );
    const restoredClean = editorFromSaved({ ...clean, uiState: JSON.stringify(clean.ui) });
    expect(isDirty(restoredClean)).toBe(false);
    expect(restoredClean.fileHash).toBe(hashText('a'));

    const edited = editorToSaved(
      editor({ content: 'ab', savedContent: 'a', filePath: '/q/a.sql', fileHash: hashText('a') }),
    );
    const restoredEdited = editorFromSaved({ ...edited, uiState: JSON.stringify(edited.ui) });
    expect(restoredEdited.savedContent).toBeNull();
    expect(isDirty(restoredEdited)).toBe(true);
  });

  it('is tolerant to a missing, foreign or corrupted uiState and a cursor out of range', () => {
    for (const uiState of [null, 'not json', '[]', '{"scroll":"x"}']) {
      const state = editorFromSaved({
        content: 'abc',
        cursor: { anchor: 99, head: -3 },
        database: null,
        filePath: null,
        uiState,
      });
      expect(state.selection).toEqual({ anchor: 3, head: 0 });
      expect(state.scrollTop).toBe(0);
    }
  });
});

describe('through the saved tabs of the shell', () => {
  const shell = {
    tabs: [
      { id: 'a', connectionId: 'c1', ordinal: 1, pinned: false },
      { id: 'b', connectionId: 'c1', ordinal: 2, pinned: true },
      { id: 'w', connectionId: null, ordinal: 0, pinned: false },
    ],
    activeTabId: 'a',
  };

  it('writes each query tab’s editor next to the shell’s fields and reads both back', () => {
    const backend = toBackendTabs(shell, title, {
      a: editor({ content: 'select 1;', savedContent: '', database: 'shop' }),
      b: editor({
        content: 'select 2;',
        savedContent: 'select 2;',
        filePath: '/q/report.sql',
        fileHash: hashText('select 2;'),
      }),
    });
    const [a, b, w] = backend.tabs;
    expect(a).toMatchObject({ title: 'Query 1', content: 'select 1;', database: 'shop' });
    // A file-bound tab is named after its file.
    expect(b).toMatchObject({ title: 'report.sql', filePath: '/q/report.sql', pinned: true });
    // A welcome tab never carries an editor.
    expect(w).toMatchObject({ content: '', filePath: null });

    expect(fromBackendTabs(backend)).toEqual(shell);
    const editors = editorsFromBackendTabs(backend);
    expect(Object.keys(editors).sort()).toEqual(['a', 'b']);
    expect(editors['a']?.content).toBe('select 1;');
    expect(isDirty(editors['b'] ?? newQueryTabState())).toBe(false);
  });

  it('keeps the shell’s ordinal in uiState with the editor’s fields', () => {
    const backend = toBackendTabs(shell, title, { a: editor({ content: 'x', scrollTop: 9 }) });
    const ui = JSON.parse(backend.tabs[0]?.uiState ?? '{}') as Record<string, unknown>;
    expect(ui).toMatchObject({ ordinal: 1, scroll: [9, 0] });
  });
});
