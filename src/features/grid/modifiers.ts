import { platform } from '../../ui/platform';
import type { SelectMode } from './selection';

type Modifiers = Pick<MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>;

/** ⌘ on macOS, Ctrl elsewhere (the `Mod` of shortcuts). */
export function modKey(event: Modifiers): boolean {
  return platform === 'mac' ? event.metaKey : event.ctrlKey;
}

/** Shift extends the selection, Mod adds to it, a plain click replaces it. */
export function selectModeOf(event: Modifiers): SelectMode {
  if (event.shiftKey) return 'extend';
  return modKey(event) ? 'add' : 'replace';
}
