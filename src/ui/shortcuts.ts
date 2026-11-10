import { platform, type Platform } from './platform';

/** `aria-keyshortcuts` value for a shortcut (`Mod` is Control on Windows and Linux, Meta on macOS). */
export function ariaKeyShortcuts(shortcut: string): string {
  const spell = (name: string) => (name === 'Ctrl' ? 'Control' : name);
  const forms = shortcut.includes('Mod')
    ? [shortcut.replace('Mod', 'Control'), shortcut.replace('Mod', 'Meta')]
    : [shortcut];
  return forms.map((form) => form.split('+').map(spell).join('+')).join(' ');
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

/** Key name of a shortcut, compared to `event.code` for letters and digits (layout and ⌥-proof). */
export function eventKey(event: KeyLike): string {
  if (event.key === ' ') return 'Space';
  const code = event.code;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad') && /\d$/.test(code)) return code.slice(6);
  // The key left of 1: a dead key on many layouts, and `~` with Shift.
  if (code === 'Backquote') return '`';
  // `+` cannot be written in a shortcut (it separates the keys): it counts as `=`, its key on
  // a US layout (Shift+=). A layout with a `+` key of its own (German, numpad) gets `Mod+=`.
  if (event.key === '+') return '=';
  return event.key;
}

/**
 * Whether `event` matches a shortcut such as `Mod+Shift+T`. `Mod` is ⌘ on macOS and Ctrl
 * elsewhere; `Ctrl` is the physical Control key everywhere. Modifiers must match exactly.
 */
export function matchShortcut(
  event: KeyLike,
  shortcut: string,
  target: Platform = platform,
): boolean {
  const parts = shortcut.split('+');
  const key = parts.pop();
  if (!key) return false;
  const wanted = { meta: false, ctrl: false, alt: false, shift: false };
  for (const modifier of parts) {
    if (modifier === 'Mod') wanted[target === 'mac' ? 'meta' : 'ctrl'] = true;
    else if (modifier === 'Ctrl') wanted.ctrl = true;
    else if (modifier === 'Alt') wanted.alt = true;
    else if (modifier === 'Shift') wanted.shift = true;
    else return false;
  }
  return (
    event.metaKey === wanted.meta &&
    event.ctrlKey === wanted.ctrl &&
    event.altKey === wanted.alt &&
    event.shiftKey === wanted.shift &&
    eventKey(event).toLowerCase() === key.toLowerCase()
  );
}
