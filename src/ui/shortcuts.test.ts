import { describe, expect, it } from 'vitest';

import { matchShortcut } from './shortcuts';

const key = (
  code: string,
  key: string,
  mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {},
) => ({ code, key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe('matchShortcut', () => {
  it('maps Mod to ⌘ on macOS and Ctrl elsewhere', () => {
    expect(matchShortcut(key('KeyT', 't', { metaKey: true }), 'Mod+T', 'mac')).toBe(true);
    expect(matchShortcut(key('KeyT', 't', { ctrlKey: true }), 'Mod+T', 'mac')).toBe(false);
    expect(matchShortcut(key('KeyT', 't', { ctrlKey: true }), 'Mod+T', 'windows')).toBe(true);
  });

  it('requires exact modifiers', () => {
    expect(
      matchShortcut(key('KeyT', 'T', { ctrlKey: true, shiftKey: true }), 'Mod+T', 'linux'),
    ).toBe(false);
  });

  it('uses the physical key for letters and digits', () => {
    // ⌥ changes event.key on macOS, and AZERTY layouts type "&" on Digit1.
    expect(
      matchShortcut(key('KeyB', '∫', { metaKey: true, altKey: true }), 'Mod+Alt+B', 'mac'),
    ).toBe(true);
    expect(matchShortcut(key('Digit1', '&', { ctrlKey: true }), 'Mod+1', 'linux')).toBe(true);
  });

  it('matches named keys', () => {
    expect(matchShortcut(key('Tab', 'Tab', { ctrlKey: true }), 'Ctrl+Tab', 'mac')).toBe(true);
    expect(
      matchShortcut(key('Tab', 'Tab', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Tab', 'mac'),
    ).toBe(true);
  });
});

describe('the key left of 1', () => {
  it('matches by position, whatever the layout or Shift', () => {
    expect(matchShortcut(key('Backquote', '`', { ctrlKey: true }), 'Ctrl+`', 'linux')).toBe(true);
    expect(matchShortcut(key('Backquote', 'Dead', { ctrlKey: true }), 'Ctrl+`', 'mac')).toBe(true);
    const shifted = key('Backquote', '~', { ctrlKey: true, shiftKey: true });
    expect(matchShortcut(shifted, 'Ctrl+Shift+`', 'windows')).toBe(true);
    expect(matchShortcut(shifted, 'Ctrl+`', 'windows')).toBe(false);
  });
});

describe('zoom keys', () => {
  it('match = and - by the character typed, and + as Shift+=', () => {
    expect(matchShortcut(key('Equal', '=', { metaKey: true }), 'Mod+=', 'mac')).toBe(true);
    expect(matchShortcut(key('Minus', '-', { ctrlKey: true }), 'Mod+-', 'linux')).toBe(true);
    expect(matchShortcut(key('Digit0', '0', { ctrlKey: true }), 'Mod+0', 'windows')).toBe(true);
    // US layout: ⌘+ is ⌘⇧=.
    expect(
      matchShortcut(key('Equal', '+', { metaKey: true, shiftKey: true }), 'Mod+Shift+=', 'mac'),
    ).toBe(true);
    // A layout (or the numpad) with a + key of its own.
    expect(matchShortcut(key('NumpadAdd', '+', { ctrlKey: true }), 'Mod+=', 'linux')).toBe(true);
  });
});
