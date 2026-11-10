import { beforeEach, describe, expect, it } from 'vitest';

import { nodeKeys } from './explorerRows';
import { createExplorerStore, ROOT_NODE } from './explorerStore';

let store: ReturnType<typeof createExplorerStore>;
const state = () => store.getState();
const open = (connectionId: string) => [...(state().expanded[connectionId] ?? [])];

beforeEach(() => {
  store = createExplorerStore();
});

describe('expanded nodes', () => {
  it('remembers the open nodes of each connection apart', () => {
    state().setExpanded('a', nodeKeys.database('shop'), true);
    state().setExpanded('b', nodeKeys.database('crm'), true);
    expect(open('a')).toEqual([nodeKeys.database('shop')]);
    expect(open('b')).toEqual([nodeKeys.database('crm')]);
  });

  it('toggles a node', () => {
    const node = nodeKeys.schema('shop', 'public');
    state().toggle('a', node);
    expect(open('a')).toEqual([node]);
    state().toggle('a', node);
    expect(open('a')).toEqual([]);
  });

  it('keeps the same object when nothing changes, so nothing re-renders', () => {
    state().setExpanded('a', nodeKeys.database('shop'), true);
    const before = state().expanded;
    state().setExpanded('a', nodeKeys.database('shop'), true);
    state().setExpanded('a', nodeKeys.database('other'), false);
    expect(state().expanded).toBe(before);
  });
});

describe('first connection', () => {
  it('opens the connection once, then the current database once', () => {
    expect(state().seed('a')).toBe(true);
    expect(open('a')).toEqual([ROOT_NODE]);
    state().seedDatabase('a', nodeKeys.database('shop'));
    expect(open('a')).toEqual([ROOT_NODE, nodeKeys.database('shop')]);
    // The user closes both: a reconnection does not open them again.
    state().setExpanded('a', ROOT_NODE, false);
    state().setExpanded('a', nodeKeys.database('shop'), false);
    expect(state().seed('a')).toBe(false);
    state().seedDatabase('a', nodeKeys.database('shop'));
    expect(open('a')).toEqual([]);
  });

  it('does not open a database of a connection that was not seeded', () => {
    state().seedDatabase('a', nodeKeys.database('shop'));
    expect(open('a')).toEqual([]);
  });
});

describe('system objects and forgetting', () => {
  it('hides system objects until asked', () => {
    expect(state().showSystem).toBe(false);
    state().setShowSystem(true);
    expect(state().showSystem).toBe(true);
  });

  it('forgets a connection', () => {
    state().seed('a');
    state().seed('b');
    state().forget('a');
    expect(state().expanded['a']).toBeUndefined();
    expect(state().seed('a')).toBe(true);
    expect(open('b')).toEqual([ROOT_NODE]);
  });
});
