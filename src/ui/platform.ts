export type Platform = 'mac' | 'windows' | 'linux';

export function detectPlatform(userAgent: string): Platform {
  if (/Mac|iPhone|iPad/i.test(userAgent)) return 'mac';
  if (/Windows/i.test(userAgent)) return 'windows';
  return 'linux';
}

export const platform: Platform = detectPlatform(navigator.userAgent);

const MAC_SYMBOLS: Record<string, string> = {
  Mod: '⌘',
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Enter: '↵',
  Escape: 'Esc',
};

const OTHER_NAMES: Record<string, string> = {
  Mod: 'Ctrl',
  Enter: 'Enter',
  Escape: 'Esc',
};

/** Splits a shortcut like `Mod+Shift+K` into display keys for the given platform. */
export function formatShortcut(shortcut: string, target: Platform = platform): string[] {
  const names = target === 'mac' ? MAC_SYMBOLS : OTHER_NAMES;
  return shortcut.split('+').map((key) => names[key] ?? key);
}
