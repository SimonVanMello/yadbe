import { matchShortcut } from '../ui/shortcuts';

/**
 * Stable action IDs and their default keyboard shortcuts (F-121). The command palette and the
 * rebinding screen (M2-6) are built on this table; `Mod` is ⌘ on macOS and Ctrl elsewhere.
 */
export const DEFAULT_BINDINGS = {
  'tab.new': 'Mod+T',
  'tab.close': 'Mod+W',
  'tab.reopenClosed': 'Mod+Shift+T',
  'tab.next': 'Ctrl+Tab',
  'tab.previous': 'Ctrl+Shift+Tab',
  'tab.select1': 'Mod+1',
  'tab.select2': 'Mod+2',
  'tab.select3': 'Mod+3',
  'tab.select4': 'Mod+4',
  'tab.select5': 'Mod+5',
  'tab.select6': 'Mod+6',
  'tab.select7': 'Mod+7',
  'tab.select8': 'Mod+8',
  'tab.select9': 'Mod+9',
  'connection.new': 'Mod+N',
  'view.toggleSidebar': 'Mod+B',
  'view.toggleStatementLog': 'Mod+J',
  // SQL editor (F-041, F-042, F-045): `query.run` runs the selection, else the whole script.
  'query.run': 'Mod+Enter',
  'query.runStatement': 'Mod+Shift+Enter',
  'query.cancel': 'Mod+.',
  'query.open': 'Mod+O',
  'query.save': 'Mod+S',
  'query.saveAs': 'Mod+Shift+S',
} as const;

export type ActionId = keyof typeof DEFAULT_BINDINGS;

const ACTION_IDS = Object.keys(DEFAULT_BINDINGS) as ActionId[];

/** Shortcut of an action, as written in `DEFAULT_BINDINGS` (`Mod+T`). */
export function shortcutOf(id: ActionId): string {
  return DEFAULT_BINDINGS[id];
}

/** The action a key press triggers, if any. */
export function findAction(event: KeyboardEvent): ActionId | null {
  for (const id of ACTION_IDS) {
    if (matchShortcut(event, DEFAULT_BINDINGS[id])) return id;
  }
  return null;
}

type Handler = () => void;
const handlers = new Map<ActionId, Handler>();

/** Registers what an action does; returns the function that removes it. */
export function registerActions(entries: Partial<Record<ActionId, Handler>>): () => void {
  const added: ActionId[] = [];
  for (const id of ACTION_IDS) {
    const handler = entries[id];
    if (handler) {
      handlers.set(id, handler);
      added.push(id);
    }
  }
  return () => {
    for (const id of added) handlers.delete(id);
  };
}

/** Runs an action; `false` when nothing is registered for it. */
export function runAction(id: ActionId): boolean {
  const handler = handlers.get(id);
  if (!handler) return false;
  handler();
  return true;
}
