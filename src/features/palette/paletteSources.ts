import { ACTION_IDS, ACTION_LABELS, shortcutFor, type ActionId } from '../../app/actions';
import type { ShellTab } from '../../app/tabs/tabsStore';
import type { MessageKey, MessageParams } from '../../i18n/i18n';
import type { ConnectionState, ConnectionSummary } from '../connections/model';
import type { HistoryEntry } from '../history/historyModel';
import { searchable } from './matcher';
import { disabledReason, type ActionContext } from './actionAvailability';
import type { ActionItem, ConnectionItem, HistoryItem, TabItem } from './paletteItems';

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** Registered for the keyboard, but listed elsewhere (tabs) or pointless in a list of actions. */
const NOT_LISTED: ReadonlySet<ActionId> = new Set([
  'palette.open',
  'tab.select1',
  'tab.select2',
  'tab.select3',
  'tab.select4',
  'tab.select5',
  'tab.select6',
  'tab.select7',
  'tab.select8',
  'tab.select9',
]);

const CATEGORIES: Record<string, MessageKey> = {
  palette: 'palette.category.view',
  view: 'palette.category.view',
  tab: 'palette.category.tab',
  query: 'palette.category.query',
  connection: 'palette.category.connection',
  explorer: 'palette.category.explorer',
  table: 'palette.category.table',
  theme: 'palette.category.appearance',
  language: 'palette.category.appearance',
};

function categoryOf(id: ActionId): MessageKey {
  return CATEGORIES[id.split('.')[0] ?? ''] ?? 'palette.category.view';
}

/** Every action of the registry, with its shortcut and, when it cannot run, why. */
export function buildActionItems(t: Translate, context: ActionContext): ActionItem[] {
  return ACTION_IDS.filter((id) => !NOT_LISTED.has(id)).map((id) => ({
    kind: 'action',
    key: `action:${id}`,
    ...searchable(t(ACTION_LABELS[id])),
    id,
    shortcut: shortcutFor(id),
    category: categoryOf(id),
    disabledReason: disabledReason(id, context),
  }));
}

export function buildConnectionItems(
  connections: readonly ConnectionSummary[],
  stateOf: (connectionId: string) => ConnectionState,
): ConnectionItem[] {
  return connections.map((connection) => ({
    kind: 'connection',
    key: `connection:${connection.id}`,
    ...searchable(connection.name),
    connection,
    state: stateOf(connection.id),
  }));
}

export interface TabEntry {
  tab: ShellTab;
  /** What the tab strip shows as its name. */
  name: string;
  connectionName: string | null;
}

export function buildTabItems(entries: readonly TabEntry[], activeTabId: string): TabItem[] {
  return entries.map(({ tab, name, connectionName }) => ({
    kind: 'tab',
    key: `tab:${tab.id}`,
    ...searchable(name),
    tabId: tab.id,
    connectionName,
    active: tab.id === activeTabId,
  }));
}

/** A statement on one line, for a list row. */
export function oneLine(sql: string, max = 140): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function buildHistoryItems(entries: readonly HistoryEntry[]): HistoryItem[] {
  return entries.map((entry) => ({
    kind: 'history',
    key: `history:${String(entry.id)}`,
    ...searchable(oneLine(entry.sql)),
    entry,
  }));
}
