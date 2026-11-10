import type { MessageKey } from '../i18n/i18n';
import { matchShortcut } from '../ui/shortcuts';

/**
 * Stable action IDs and their default keyboard shortcuts (F-121). The command palette and the
 * rebinding screen (V1) are built on this table; `Mod` is ⌘ on macOS and Ctrl elsewhere.
 * Actions without a default shortcut are in `UNBOUND_ACTIONS`: reachable from the palette.
 */
export const DEFAULT_BINDINGS = {
  'palette.open': 'Mod+K',
  // Opens the palette on its actions (`>` prefix).
  'palette.commands': 'Mod+Shift+P',
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
  // Sidebar: History view (F-101), search focused.
  'view.history': 'Mod+Shift+H',
  // SQL editor (F-041, F-042, F-045): `query.run` runs the selection, else the whole script.
  'query.run': 'Mod+Enter',
  'query.runStatement': 'Mod+Shift+Enter',
  'query.cancel': 'Mod+.',
  'query.open': 'Mod+O',
  'query.save': 'Mod+S',
  'query.saveAs': 'Mod+Shift+S',
} as const;

/** Other shortcuts of an action, besides its own in `DEFAULT_BINDINGS`. */
export const ALIAS_BINDINGS: Partial<Record<keyof typeof DEFAULT_BINDINGS, readonly string[]>> = {
  'palette.open': ['Mod+P'],
};

/** Actions with no default shortcut: menus, buttons and the palette reach them. */
export const UNBOUND_ACTIONS = [
  'view.connections',
  'explorer.refresh',
  'explorer.toggleSystem',
  'tab.togglePin',
  'query.commit',
  'query.rollback',
  'theme.light',
  'theme.dark',
  'theme.system',
  'language.en',
  'language.fr',
] as const;

export type BoundActionId = keyof typeof DEFAULT_BINDINGS;
export type ActionId = BoundActionId | (typeof UNBOUND_ACTIONS)[number];

/** Every action, in registry order. */
export const ACTION_IDS: readonly ActionId[] = [
  ...(Object.keys(DEFAULT_BINDINGS) as BoundActionId[]),
  ...UNBOUND_ACTIONS,
];

/** Name of each action in the palette (`action.<id>` in the catalogs); complete by type. */
export const ACTION_LABELS: Record<ActionId, MessageKey> = {
  'palette.open': 'action.palette.open',
  'palette.commands': 'action.palette.commands',
  'tab.new': 'action.tab.new',
  'tab.close': 'action.tab.close',
  'tab.reopenClosed': 'action.tab.reopenClosed',
  'tab.next': 'action.tab.next',
  'tab.previous': 'action.tab.previous',
  'tab.select1': 'action.tab.select1',
  'tab.select2': 'action.tab.select2',
  'tab.select3': 'action.tab.select3',
  'tab.select4': 'action.tab.select4',
  'tab.select5': 'action.tab.select5',
  'tab.select6': 'action.tab.select6',
  'tab.select7': 'action.tab.select7',
  'tab.select8': 'action.tab.select8',
  'tab.select9': 'action.tab.select9',
  'connection.new': 'action.connection.new',
  'view.toggleSidebar': 'action.view.toggleSidebar',
  'view.toggleStatementLog': 'action.view.toggleStatementLog',
  'view.history': 'action.view.history',
  'query.run': 'action.query.run',
  'query.runStatement': 'action.query.runStatement',
  'query.cancel': 'action.query.cancel',
  'query.open': 'action.query.open',
  'query.save': 'action.query.save',
  'query.saveAs': 'action.query.saveAs',
  'view.connections': 'action.view.connections',
  'explorer.refresh': 'action.explorer.refresh',
  'explorer.toggleSystem': 'action.explorer.toggleSystem',
  'tab.togglePin': 'action.tab.togglePin',
  'query.commit': 'action.query.commit',
  'query.rollback': 'action.query.rollback',
  'theme.light': 'action.theme.light',
  'theme.dark': 'action.theme.dark',
  'theme.system': 'action.theme.system',
  'language.en': 'action.language.en',
  'language.fr': 'action.language.fr',
};

/** Shortcut of an action that has one, as written in `DEFAULT_BINDINGS` (`Mod+T`). */
export function shortcutOf(id: BoundActionId): string {
  return DEFAULT_BINDINGS[id];
}

/** Shortcut of any action, `null` when it has none. */
export function shortcutFor(id: ActionId): string | null {
  return id in DEFAULT_BINDINGS ? DEFAULT_BINDINGS[id as BoundActionId] : null;
}

/** The action a key press triggers, if any. */
export function findAction(event: KeyboardEvent): ActionId | null {
  for (const id of Object.keys(DEFAULT_BINDINGS) as BoundActionId[]) {
    if (matchShortcut(event, DEFAULT_BINDINGS[id])) return id;
    if (ALIAS_BINDINGS[id]?.some((alias) => matchShortcut(event, alias))) return id;
  }
  return null;
}

type Handler = () => void;
const handlers = new Map<ActionId, Handler>();

/** The actions something is registered for: what the palette can run. */
export function registeredActions(): ReadonlySet<ActionId> {
  return new Set(handlers.keys());
}

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
