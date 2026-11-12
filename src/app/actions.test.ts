import { describe, expect, it, vi } from 'vitest';

import { catalogs, locales } from '../i18n/i18n';
import {
  ACTION_IDS,
  ACTION_LABELS,
  ALIAS_BINDINGS,
  DEFAULT_BINDINGS,
  findAction,
  findActions,
  registerActions,
  runAction,
  shortcutFor,
  TAB_SCOPES,
  type ActionId,
} from './actions';

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
