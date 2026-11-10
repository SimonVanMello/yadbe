import { beforeEach, describe, expect, it } from 'vitest';

import {
  createQueryTabStore,
  fileNameOf,
  hashText,
  isDirty,
  newQueryTabState,
} from './queryTabStore';

let store: ReturnType<typeof createQueryTabStore>;
const state = (id = 't1') => store.getState().tabs[id] ?? newQueryTabState();

beforeEach(() => {
  store = createQueryTabStore();
});

describe('the editor state of a tab', () => {
  it('starts empty and clean, and a new text makes it dirty', () => {
    store.getState().ensure('t1');
    expect(isDirty(state())).toBe(false);
    store.getState().setContent('t1', 'select 1');
    expect(state().content).toBe('select 1');
    expect(isDirty(state())).toBe(true);
  });

  it('creates the tab on the first write, and ensure never overwrites', () => {
    store.getState().setSelection('t2', { anchor: 2, head: 5 });
    expect(state('t2').selection).toEqual({ anchor: 2, head: 5 });
    store.getState().ensure('t2');
    expect(state('t2').selection).toEqual({ anchor: 2, head: 5 });
  });

  it('keeps the same state object when nothing changes, so nothing re-renders', () => {
    store.getState().setContent('t1', 'a');
    const before = store.getState().tabs;
    store.getState().setContent('t1', 'a');
    store.getState().setSelection('t1', { anchor: 0, head: 0 });
    store.getState().setScroll('t1', 0, 0);
    store.getState().setDatabase('t1', null);
    expect(store.getState().tabs).toBe(before);
  });

  it('remembers scroll and database', () => {
    store.getState().setScroll('t1', 120, 8);
    store.getState().setDatabase('t1', 'analytics');
    expect(state()).toMatchObject({ scrollTop: 120, scrollLeft: 8, database: 'analytics' });
  });
});

describe('files', () => {
  it('opening a file binds the tab, clean, with the file’s hash', () => {
    store.getState().loadFile('t1', '/home/ana/q/report.sql', 'select 1;\n');
    expect(state()).toMatchObject({
      filePath: '/home/ana/q/report.sql',
      content: 'select 1;\n',
      fileHash: hashText('select 1;\n'),
    });
    expect(isDirty(state())).toBe(false);
  });

  it('editing makes it dirty, saving makes it clean again', () => {
    store.getState().loadFile('t1', '/q/a.sql', 'select 1;');
    store.getState().setContent('t1', 'select 2;');
    expect(isDirty(state())).toBe(true);
    store.getState().markSaved('t1', '/q/a.sql', 'select 2;');
    expect(isDirty(state())).toBe(false);
    expect(state().fileHash).toBe(hashText('select 2;'));
  });

  it('a save of older text leaves the newer edits dirty', () => {
    store.getState().loadFile('t1', '/q/a.sql', 'a');
    store.getState().setContent('t1', 'ab');
    store.getState().markSaved('t1', '/q/a.sql', 'ab');
    store.getState().setContent('t1', 'abc');
    expect(isDirty(state())).toBe(true);
  });

  it('detaching keeps the text, which then counts as unsaved', () => {
    store.getState().loadFile('t1', '/q/a.sql', 'select 1;');
    store.getState().detachFile('t1');
    expect(state()).toMatchObject({ filePath: null, content: 'select 1;', fileHash: null });
    expect(isDirty(state())).toBe(true);
  });

  it('removes a tab', () => {
    store.getState().setContent('t1', 'x');
    store.getState().remove('t1');
    expect(store.getState().tabs['t1']).toBeUndefined();
  });
});

describe('helpers', () => {
  it('hashes equal texts equally and different texts differently', () => {
    expect(hashText('select 1')).toBe(hashText('select 1'));
    expect(hashText('select 1')).not.toBe(hashText('select 2'));
    expect(hashText('')).not.toBe(hashText(' '));
  });

  it('takes the file name of a Unix or Windows path', () => {
    expect(fileNameOf('/home/ana/q/report.sql')).toBe('report.sql');
    expect(fileNameOf('C:\\Users\\ana\\report.sql')).toBe('report.sql');
  });
});
