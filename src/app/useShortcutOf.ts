import { useCallback } from 'react';

import { resolveShortcut, type ActionId } from './actions';
import { useKeybindingsStore } from './keybindingsStore';

/**
 * The shortcut of an action as it is now, for rendering: the function changes when the user
 * rebinds, so the hints (tooltips, menus) follow.
 */
export function useShortcutOf(): (id: ActionId) => string | undefined {
  const overrides = useKeybindingsStore((state) => state.overrides);
  return useCallback((id) => resolveShortcut(id, overrides) ?? undefined, [overrides]);
}
