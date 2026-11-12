import { describe, expect, it } from 'vitest';

import {
  canonicalShortcut,
  captureShortcut,
  clashesWith,
  findConflicts,
  parseOverrides,
  shortcutKey,
} from './keybindingsLogic';

const press = (init: Partial<KeyboardEvent> & { key: string; code: string }) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

describe('canonicalShortcut', () => {
  it('orders the modifiers and upper-cases a letter', () => {
    expect(canonicalShortcut('Shift+Alt+f')).toBe('Alt+Shift+F');
    expect(canonicalShortcut('Alt+Mod+Enter')).toBe('Mod+Alt+Enter');
  });
});

describe('shortcutKey', () => {
  it('counts Ctrl as Mod outside macOS only', () => {
    expect(shortcutKey('Ctrl+K', 'linux')).toBe(shortcutKey('Mod+K', 'linux'));
    expect(shortcutKey('Ctrl+K', 'mac')).not.toBe(shortcutKey('Mod+K', 'mac'));
  });
});

describe('captureShortcut', () => {
  it('turns Ctrl+Shift+K into Mod+Shift+K on Linux and Windows', () => {
    const event = press({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true });
    expect(captureShortcut(event, 'linux')).toEqual({ kind: 'shortcut', shortcut: 'Mod+Shift+K' });
  });

  it('turns ⌘⌃K into Mod+Ctrl+K on macOS', () => {
    const event = press({ key: 'k', code: 'KeyK', metaKey: true, ctrlKey: true });
    expect(captureShortcut(event, 'mac')).toEqual({ kind: 'shortcut', shortcut: 'Mod+Ctrl+K' });
  });

  it('waits while only modifiers are down, cancels on Escape', () => {
    expect(
      captureShortcut(press({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), 'linux'),
    ).toEqual({ kind: 'pending' });
    expect(captureShortcut(press({ key: 'Escape', code: 'Escape' }), 'linux')).toEqual({
      kind: 'cancel',
    });
  });

  it('refuses a bare letter, Shift+letter and the Windows key, accepts a bare function key', () => {
    expect(captureShortcut(press({ key: 'a', code: 'KeyA' }), 'linux').kind).toBe('invalid');
    expect(captureShortcut(press({ key: 'A', code: 'KeyA', shiftKey: true }), 'linux').kind).toBe(
      'invalid',
    );
    expect(captureShortcut(press({ key: 'k', code: 'KeyK', metaKey: true }), 'windows').kind).toBe(
      'invalid',
    );
    expect(captureShortcut(press({ key: 'F5', code: 'F5' }), 'linux')).toEqual({
      kind: 'shortcut',
      shortcut: 'F5',
    });
  });

  it('refuses dead keys', () => {
    expect(
      captureShortcut(press({ key: 'Dead', code: 'BracketLeft', ctrlKey: true }), 'linux').kind,
    ).toBe('invalid');
  });
});

describe('parseOverrides', () => {
  const known = ['tab.new', 'query.run', 'theme.dark'];

  it('keeps known actions with a usable shortcut or null, and drops the rest', () => {
    const saved = {
      version: 1,
      overrides: {
        'tab.new': 'Alt+Shift+n',
        'query.run': null,
        'theme.dark': 'Hyper+D',
        'nope.action': 'Mod+Q',
        'tab.close': 'Mod+W',
      },
    };
    expect(parseOverrides(saved, known)).toEqual({ 'tab.new': 'Alt+Shift+N', 'query.run': null });
  });

  it('tolerates anything else', () => {
    expect(parseOverrides(undefined, known)).toEqual({});
    expect(parseOverrides('x', known)).toEqual({});
    expect(parseOverrides({ overrides: [] }, known)).toEqual({});
    expect(parseOverrides({ overrides: { 'tab.new': 3 } }, known)).toEqual({});
  });
});

describe('conflicts', () => {
  const scopes = ['query.', 'table.'];

  it('lets actions of different tab kinds share a shortcut, not the others', () => {
    const effective = new Map<string, string | null>([
      ['query.save', 'Mod+S'],
      ['table.apply', 'Mod+S'],
      ['tab.new', 'Mod+T'],
      ['view.history', 'Mod+T'],
      ['query.run', null],
    ]);
    const found = findConflicts(effective, scopes, 'linux');
    expect([...found.values()]).toEqual([['tab.new', 'view.history']]);
  });

  it('lists who already holds a shortcut an action is about to take', () => {
    const effective = new Map<string, string | null>([
      ['query.save', 'Mod+S'],
      ['table.apply', 'Mod+S'],
      ['tab.new', 'Mod+T'],
    ]);
    expect(clashesWith('query.run', 'Ctrl+T', effective, scopes, 'linux')).toEqual(['tab.new']);
    expect(clashesWith('view.history', 'Mod+S', effective, scopes, 'linux')).toEqual([
      'query.save',
      'table.apply',
    ]);
    // Another tab kind's action may share it (`query.save`), the same kind's may not.
    expect(clashesWith('table.refresh', 'Mod+S', effective, scopes, 'linux')).toEqual([
      'table.apply',
    ]);
    expect(clashesWith('view.history', 'Mod+Y', effective, scopes, 'linux')).toEqual([]);
    // Moving an action to a shortcut it already has is not a conflict with itself.
    expect(clashesWith('tab.new', 'Mod+T', effective, scopes, 'linux')).toEqual([]);
  });
});
