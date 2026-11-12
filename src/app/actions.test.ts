import { afterEach, describe, expect, it, vi } from 'vitest';

import { catalogs, locales } from '../i18n/i18n';
import {
  ACTION_IDS,
  ACTION_LABELS,
  ALIAS_BINDINGS,
  DEFAULT_BINDINGS,
  findAction,
  findActions,
  matchesAction,
  registerActions,
  runAction,
  shortcutFor,
  TAB_SCOPES,
  type ActionId,
} from './actions';
import { useKeybindingsStore } from './keybindingsStore';

function key(init: Partial<KeyboardEvent> & { key: string; code: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', { ...init });
}

/** Combinations the OS or the webview keeps for itself on some platform (⌘ is `Mod` on macOS). */
const RESERVED = [
  'Mod+Q', // quit (macOS)
  'Mod+H', // hide the app (macOS)
  'Mod+M', // minimize (macOS)
  'Mod+Space', // Spotlight (macOS)
  'Mod+Tab', // app switcher (macOS); `Ctrl+Tab` is ours on purpose
  'Mod+R', // reload the webview
  'Mod+F4', // close the window (Windows)
  'Alt+F4',
];

describe('shortcut table', () => {
  const bound = (Object.keys(DEFAULT_BINDINGS) as (keyof typeof DEFAULT_BINDINGS)[]).flatMap((id) =>
    [DEFAULT_BINDINGS[id], ...(ALIAS_BINDINGS[id] ?? [])].map((shortcut) => ({ id, shortcut })),
  );

  it('gives no combination to two actions, aliases included, but across tab kinds', () => {
    const scopeOf = (id: string) => TAB_SCOPES.find((scope) => id.startsWith(scope)) ?? null;
    const seen = new Map<string, string[]>();
    for (const { id, shortcut } of bound) {
      const normalized = shortcut.toLowerCase();
      const others = seen.get(normalized) ?? [];
      // `query.save` and `table.apply` share `Mod+S`: only one kind of tab is active at a time.
      const clash = others.find(
        (other) => scopeOf(other) === null || scopeOf(other) === scopeOf(id),
      );
      expect(clash, `${shortcut} (${id}) is also ${clash ?? ''}`).toBeUndefined();
      seen.set(normalized, [...others, id]);
    }
  });

  it('runs the next action bound to a key when the first does not apply', () => {
    const save = vi.fn(() => false);
    const apply = vi.fn();
    const off = registerActions({ 'query.save': save, 'table.apply': apply });
    const event = key({ key: 's', code: 'KeyS', ctrlKey: true });
    expect(findActions(event)).toEqual(['query.save', 'table.apply']);
    expect(runAction('query.save')).toBe(false);
    expect(runAction('table.apply')).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    off();
  });

  it('avoids the combinations an OS keeps for itself', () => {
    for (const { id, shortcut } of bound) {
      expect(RESERVED, `${id} uses ${shortcut}`).not.toContain(shortcut);
    }
  });

  it('opens the palette with ⌘K and ⌘P, its actions with ⌘⇧P', () => {
    expect(findAction(key({ key: 'k', code: 'KeyK', ctrlKey: true }))).toBe('palette.open');
    expect(findAction(key({ key: 'p', code: 'KeyP', ctrlKey: true }))).toBe('palette.open');
    expect(findAction(key({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }))).toBe(
      'palette.commands',
    );
  });

  it('writes every shortcut with known modifiers and one key', () => {
    for (const { shortcut } of bound) {
      const parts = shortcut.split('+');
      for (const modifier of parts.slice(0, -1)) {
        expect(['Mod', 'Ctrl', 'Alt', 'Shift']).toContain(modifier);
      }
      expect(parts.at(-1)).toBeTruthy();
    }
  });
});

describe('action labels', () => {
  it.each(ACTION_IDS)('%s has a name in every language', (id) => {
    for (const locale of locales) {
      expect(catalogs[locale][ACTION_LABELS[id]].trim(), `${locale} ${id}`).not.toBe('');
    }
  });

  it('gives a shortcut to the bound actions and none to the others', () => {
    expect(shortcutFor('tab.new')).toBe('Mod+T');
    expect(shortcutFor('theme.dark')).toBeNull();
  });
});

describe('default bindings', () => {
  it('never give two actions the same shortcut, but Save / Apply and F12 (query and table tabs)', () => {
    const shared = new Set(['table.apply', 'query.goToDefinition']);
    const shortcuts = Object.entries(DEFAULT_BINDINGS)
      .filter(([id]) => !shared.has(id))
      .map(([, shortcut]) => shortcut);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
    expect(DEFAULT_BINDINGS['table.apply']).toBe(DEFAULT_BINDINGS['query.save']);
    // Go to the definition of a name in a query tab, follow a foreign key in a table tab.
    expect(DEFAULT_BINDINGS['query.goToDefinition']).toBe(DEFAULT_BINDINGS['table.goToReference']);
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

describe('rebound shortcuts', () => {
  afterEach(() => {
    useKeybindingsStore.getState().resetAll();
  });

  it('follow the user: the new key triggers the action, the default no longer does', () => {
    useKeybindingsStore.getState().set('tab.new', 'Mod+Alt+N');
    expect(shortcutFor('tab.new')).toBe('Mod+Alt+N');
    expect(findAction(key({ key: 'n', code: 'KeyN', ctrlKey: true, altKey: true }))).toBe(
      'tab.new',
    );
    expect(findAction(key({ key: 't', code: 'KeyT', ctrlKey: true }))).toBeNull();
  });

  it('can leave an action without a shortcut, and give one to an action that had none', () => {
    useKeybindingsStore.getState().setMany({ 'tab.close': null, 'query.commit': 'Mod+Alt+C' });
    expect(shortcutFor('tab.close')).toBeNull();
    expect(findAction(key({ key: 'w', code: 'KeyW', ctrlKey: true }))).toBeNull();
    expect(findAction(key({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: true }))).toBe(
      'query.commit',
    );
  });

  it('go back to the defaults', () => {
    useKeybindingsStore.getState().set('tab.new', 'Mod+Alt+N');
    useKeybindingsStore.getState().reset('tab.new');
    expect(shortcutFor('tab.new')).toBe('Mod+T');
    useKeybindingsStore.getState().set('tab.close', null);
    useKeybindingsStore.getState().resetAll();
    expect(shortcutFor('tab.close')).toBe('Mod+W');
  });

  it('drop the alias of an action once it is rebound, or once another action takes it', () => {
    const modP = key({ key: 'p', code: 'KeyP', ctrlKey: true });
    expect(findAction(modP)).toBe('palette.open');
    useKeybindingsStore.getState().set('palette.open', 'Mod+Alt+K');
    expect(findAction(modP)).toBeNull();
    useKeybindingsStore.getState().resetAll();
    useKeybindingsStore.getState().set('query.format', 'Mod+P');
    expect(findAction(modP)).toBe('query.format');
  });

  it('are matched by matchesAction in handlers', () => {
    useKeybindingsStore.getState().set('table.setNull', 'Mod+Alt+0');
    const rebound = key({ key: '0', code: 'Digit0', ctrlKey: true, altKey: true });
    const old = key({ key: 'Backspace', code: 'Backspace', ctrlKey: true });
    expect(matchesAction(rebound, 'table.setNull')).toBe(true);
    expect(matchesAction(old, 'table.setNull')).toBe(false);
  });
});
