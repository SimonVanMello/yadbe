import type { MessageKey } from '../i18n/i18n';
import { matchShortcut } from '../ui/shortcuts';
import { shortcutKey, type Overrides } from './keybindingsLogic';
import { useKeybindingsStore } from './keybindingsStore';

/**
 * Stable action IDs and their default keyboard shortcuts (F-121). The command palette and the
 * rebinding screen are built on this table (the user's changes live in `keybindingsStore`); `Mod` is ⌘ on macOS and Ctrl elsewhere.
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
  // The preferences screen (F-125).
  'preferences.open': 'Mod+,',
  'view.toggleSidebar': 'Mod+B',
  'view.toggleStatementLog': 'Mod+J',
  // Sidebar: History view (F-101), search focused.
  'view.history': 'Mod+Shift+H',
  // Sidebar: Saved queries view (F-050), search focused.
  'view.library': 'Mod+Shift+B',
  // SQL editor (F-041, F-042, F-045): `query.run` runs the selection, else the whole script.
  'query.run': 'Mod+Enter',
  'query.runStatement': 'Mod+Shift+Enter',
  'query.cancel': 'Mod+.',
  'query.open': 'Mod+O',
  'query.save': 'Mod+S',
  'query.saveAs': 'Mod+Shift+S',
  // The selection, or the whole tab, into the query library (F-050): not the `.sql` file save.
  'query.saveToLibrary': 'Mod+Shift+L',
  // Results (F-066): the export dialog of the result on screen.
  'result.export': 'Mod+Shift+E',
  // The grid's side panel on the focused row (F-068): one line per column.
  'result.rowDetail': 'Mod+Shift+D',
  // Filters the rows of the result on screen (F-065): the filter bar, without running again.
  'result.filter': 'Mod+Shift+F',
  // Table tabs (F-080 to F-085). `Mod+S` is Save in a query tab and Apply in a table tab: a
  // handler returns `false` where it does not apply, and the next action bound to the key runs.
  'table.apply': 'Mod+S',
  'table.refresh': 'F5',
  'table.filter': 'Mod+F',
  'table.insertRow': 'Mod+I',
  'table.duplicateRows': 'Mod+D',
  'table.deleteRows': 'Mod+Delete',
  'table.setNull': 'Mod+Backspace',
  'table.nextPage': 'Alt+PageDown',
  'table.previousPage': 'Alt+PageUp',
  // Foreign key navigation (F-088), as code editors go to a definition: F12 jumps, Alt+F12
  // peeks, Shift+F12 lists what references; Alt+← / Alt+→ walk the trail of jumps.
  'table.goToReference': 'F12',
  'table.peekReference': 'Alt+F12',
  'table.referencingRows': 'Shift+F12',
  'table.navigateBack': 'Alt+ArrowLeft',
  'table.navigateForward': 'Alt+ArrowRight',
  // Query tools (F-049, F-052, F-053). `Mod+L` explains as in SSMS and Azure Data Studio; F12
  // goes to the definition of the name at the cursor, as code editors do (and as table tabs
  // follow a foreign key with it).
  'query.format': 'Shift+Alt+F',
  'query.explain': 'Mod+L',
  'query.explainAnalyze': 'Mod+Alt+L',
  'query.goToDefinition': 'F12',
} as const;

/**
 * Prefixes of actions that only act in one kind of tab. Two such actions of different kinds
 * may share a shortcut (`query.save` and `table.apply`): only one can act at a time.
 */
export const TAB_SCOPES = ['query.', 'table.'] as const;

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
  'query.updateSavedQuery',
  'theme.light',
  'theme.dark',
  'theme.system',
  'language.en',
  'language.fr',
  'table.preview',
  'table.revertCells',
  'table.revertRows',
  'table.revertAll',
  'table.countExact',
  'table.pasteRows',
  'table.export',
  // Change journal (F-090): the sidebar view, and the change sets of the active table tab.
  'view.journal',
  'table.journal',
  'table.showDdl',
  'table.properties',
  'table.togglePin',
  'table.import',
  'connection.import',
  'connection.export',
  'query.runSameParameters',
  'query.openDefinitionData',
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
  'preferences.open': 'action.preferences.open',
  'view.toggleSidebar': 'action.view.toggleSidebar',
  'view.toggleStatementLog': 'action.view.toggleStatementLog',
  'view.history': 'action.view.history',
  'view.library': 'action.view.library',
  'result.export': 'action.result.export',
  'result.rowDetail': 'action.result.rowDetail',
  'result.filter': 'action.result.filter',
  'query.run': 'action.query.run',
  'query.runStatement': 'action.query.runStatement',
  'query.cancel': 'action.query.cancel',
  'query.open': 'action.query.open',
  'query.save': 'action.query.save',
  'query.saveAs': 'action.query.saveAs',
  'query.saveToLibrary': 'action.query.saveToLibrary',
  'view.connections': 'action.view.connections',
  'explorer.refresh': 'action.explorer.refresh',
  'explorer.toggleSystem': 'action.explorer.toggleSystem',
  'tab.togglePin': 'action.tab.togglePin',
  'query.commit': 'action.query.commit',
  'query.rollback': 'action.query.rollback',
  'query.updateSavedQuery': 'action.query.updateSavedQuery',
  'theme.light': 'action.theme.light',
  'theme.dark': 'action.theme.dark',
  'theme.system': 'action.theme.system',
  'language.en': 'action.language.en',
  'language.fr': 'action.language.fr',
  'table.apply': 'action.table.apply',
  'table.refresh': 'action.table.refresh',
  'table.filter': 'action.table.filter',
  'table.insertRow': 'action.table.insertRow',
  'table.duplicateRows': 'action.table.duplicateRows',
  'table.deleteRows': 'action.table.deleteRows',
  'table.setNull': 'action.table.setNull',
  'table.nextPage': 'action.table.nextPage',
  'table.previousPage': 'action.table.previousPage',
  'table.preview': 'action.table.preview',
  'table.revertCells': 'action.table.revertCells',
  'table.revertRows': 'action.table.revertRows',
  'table.revertAll': 'action.table.revertAll',
  'table.countExact': 'action.table.countExact',
  'table.pasteRows': 'action.table.pasteRows',
  'table.export': 'action.table.export',
  'table.showDdl': 'action.table.showDdl',
  'table.properties': 'action.table.properties',
  'table.togglePin': 'action.table.togglePin',
  'table.import': 'action.table.import',
  'connection.import': 'action.connection.import',
  'connection.export': 'action.connection.export',
  'table.goToReference': 'action.table.goToReference',
  'table.peekReference': 'action.table.peekReference',
  'table.referencingRows': 'action.table.referencingRows',
  'table.navigateBack': 'action.table.navigateBack',
  'table.navigateForward': 'action.table.navigateForward',
  'view.journal': 'action.view.journal',
  'table.journal': 'action.table.journal',
  'query.format': 'action.query.format',
  'query.explain': 'action.query.explain',
  'query.explainAnalyze': 'action.query.explainAnalyze',
  'query.goToDefinition': 'action.query.goToDefinition',
  'query.runSameParameters': 'action.query.runSameParameters',
  'query.openDefinitionData': 'action.query.openDefinitionData',
};

/** The default shortcut of an action, `null` when it has none. */
export function defaultShortcutOf(id: ActionId): string | null {
  return id in DEFAULT_BINDINGS ? DEFAULT_BINDINGS[id as BoundActionId] : null;
}

/** The shortcut of an action given what the user changed: theirs, else the default. */
export function resolveShortcut(id: ActionId, overrides: Overrides): string | null {
  return id in overrides ? (overrides[id] ?? null) : defaultShortcutOf(id);
}

/** Every action with the shortcut it has now (`null` when none), in registry order. */
export function effectiveBindings(
  overrides: Overrides = useKeybindingsStore.getState().overrides,
): Map<ActionId, string | null> {
  return new Map(ACTION_IDS.map((id) => [id, resolveShortcut(id, overrides)]));
}

/** Shortcut of any action as it is now, `null` when it has none. */
export function shortcutFor(id: ActionId): string | null {
  return resolveShortcut(id, useKeybindingsStore.getState().overrides);
}

/** Like `shortcutFor`, for a prop that is absent when there is none. */
export function shortcutOf(id: ActionId): string | undefined {
  return shortcutFor(id) ?? undefined;
}

/**
 * Every shortcut each action answers to: its own, and its aliases while nothing else takes them
 * (an alias is a convenience: the user's bindings win over it, and rebinding the action drops it).
 */
function activeShortcuts(overrides: Overrides): Map<ActionId, string[]> {
  const effective = effectiveBindings(overrides);
  const taken = new Set<string>();
  for (const shortcut of effective.values()) if (shortcut) taken.add(shortcutKey(shortcut));
  return new Map(
    ACTION_IDS.map((id) => {
      const own = effective.get(id) ?? null;
      const aliases = id in overrides ? [] : (ALIAS_BINDINGS[id as BoundActionId] ?? []);
      return [
        id,
        [...(own ? [own] : []), ...aliases.filter((alias) => !taken.has(shortcutKey(alias)))],
      ];
    }),
  );
}

/** Whether a key press is the shortcut of an action as it is now. */
export function matchesAction(event: Parameters<typeof matchShortcut>[0], id: ActionId): boolean {
  const shortcuts = activeShortcuts(useKeybindingsStore.getState().overrides).get(id) ?? [];
  return shortcuts.some((shortcut) => matchShortcut(event, shortcut));
}

/** The action a key press triggers, if any (the first one when tab scopes share the key). */
export function findAction(event: KeyboardEvent): ActionId | null {
  return findActions(event)[0] ?? null;
}

/** Every action bound to a key press, in registry order. */
export function findActions(event: KeyboardEvent): ActionId[] {
  const active = activeShortcuts(useKeybindingsStore.getState().overrides);
  return ACTION_IDS.filter((id) =>
    (active.get(id) ?? []).some((shortcut) => matchShortcut(event, shortcut)),
  );
}

/**
 * What an action does. Returning `false` means it does not apply here (another kind of tab is
 * active): the next action bound to the same key gets it. Any other result counts as done.
 */
type Handler = () => unknown;
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

/** Runs an action; `false` when nothing is registered for it or it does not apply here. */
export function runAction(id: ActionId): boolean {
  const handler = handlers.get(id);
  if (!handler) return false;
  return handler() !== false;
}
