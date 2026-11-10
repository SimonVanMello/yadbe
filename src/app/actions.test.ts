import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_BINDINGS, findAction, registerActions, runAction, type ActionId } from './actions';

function key(init: Partial<KeyboardEvent> & { key: string; code: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', { ...init });
}

describe('default bindings', () => {
  it('never give two actions the same shortcut', () => {
    const shortcuts = Object.values(DEFAULT_BINDINGS);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it('cover the tab shortcuts of F-122: ⌘T, ⌘W, ⌘1…9 and ⌃Tab', () => {
    const ids = Object.keys(DEFAULT_BINDINGS);
    for (const id of ['tab.new', 'tab.close', 'tab.next', 'tab.previous', 'tab.reopenClosed']) {
      expect(ids).toContain(id);
    }
    for (let n = 1; n <= 9; n += 1) expect(ids).toContain(`tab.select${String(n)}`);
  });
});

describe('findAction', () => {
  // Tests run as Linux: `Mod` is Ctrl.
  it('finds an action by its key combination and nothing for an unbound one', () => {
    expect(findAction(key({ key: 't', code: 'KeyT', ctrlKey: true }))).toBe('tab.new');
    expect(findAction(key({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true }))).toBe(
      'tab.reopenClosed',
    );
    expect(findAction(key({ key: '3', code: 'Digit3', ctrlKey: true }))).toBe('tab.select3');
    expect(findAction(key({ key: 'Tab', code: 'Tab', ctrlKey: true }))).toBe('tab.next');
    expect(findAction(key({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }))).toBe(
      'tab.previous',
    );
    expect(findAction(key({ key: 't', code: 'KeyT' }))).toBeNull();
    expect(findAction(key({ key: 'q', code: 'KeyQ', ctrlKey: true }))).toBeNull();
  });
});

describe('registerActions', () => {
  it('runs the registered handler and forgets it when unregistered', () => {
    const handler = vi.fn();
    const id: ActionId = 'view.toggleSidebar';
    const unregister = registerActions({ [id]: handler });
    expect(runAction(id)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    unregister();
    expect(runAction(id)).toBe(false);
  });
});
