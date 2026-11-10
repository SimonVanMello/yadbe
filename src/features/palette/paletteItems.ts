import type { ActionId } from '../../app/actions';
import type { MessageKey } from '../../i18n/i18n';
import type { ObjectKind } from '../../ipc';
import type { IconName } from '../../ui/Icon';
import type { ConnectionState, ConnectionSummary } from '../connections/model';
import { KIND_ICONS } from '../explorer/explorerLabels';
import type { HistoryEntry } from '../history/historyModel';
import type { Searchable } from './matcher';

export type PaletteKind = 'action' | 'connection' | 'tab' | 'object' | 'history';

/** What the palette lists: everything, or one kind chosen with a prefix. */
export type PaletteMode = 'all' | PaletteKind;

export interface ActionItem extends Searchable {
  kind: 'action';
  key: string;
  id: ActionId;
  /** Shortcut in `Mod+K` notation. */
  shortcut: string | null;
  category: MessageKey;
  /** Why the action cannot run right now; `null` when it can. */
  disabledReason: MessageKey | null;
}

export interface ConnectionItem extends Searchable {
  kind: 'connection';
  key: string;
  connection: ConnectionSummary;
  state: ConnectionState;
}

export interface TabItem extends Searchable {
  kind: 'tab';
  key: string;
  tabId: string;
  /** Name of the tab's connection; `null` on a new (welcome) tab. */
  connectionName: string | null;
  active: boolean;
}

export interface ObjectItem extends Searchable {
  kind: 'object';
  key: string;
  connectionId: string;
  connectionName: string;
  database: string;
  schema: string | null;
  name: string;
  objectKind: ObjectKind;
  /** Argument types of a routine, as the catalog has them. */
  signature: string | null;
}

export interface HistoryItem extends Searchable {
  kind: 'history';
  key: string;
  entry: HistoryEntry;
}

export type PaletteItem = ActionItem | ConnectionItem | TabItem | ObjectItem | HistoryItem;

/** Prefixes narrowing the search to one kind (`>` commands, as in VS Code). */
export const MODE_PREFIXES: Record<string, PaletteKind> = {
  '>': 'action',
  ':': 'connection',
  '#': 'tab',
  '@': 'object',
  '!': 'history',
};

/** The prefix of each kind, for the hint row. */
export const KIND_PREFIX: Record<PaletteKind, string> = {
  action: '>',
  connection: ':',
  tab: '#',
  object: '@',
  history: '!',
};

export interface ParsedQuery {
  mode: PaletteMode;
  text: string;
}

export function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trimStart();
  const mode = MODE_PREFIXES[trimmed.charAt(0)];
  return mode ? { mode, text: trimmed.slice(1).trim() } : { mode: 'all', text: trimmed.trim() };
}

export const GROUP_LABELS: Record<PaletteKind, MessageKey> = {
  action: 'palette.group.action',
  connection: 'palette.group.connection',
  tab: 'palette.group.tab',
  object: 'palette.group.object',
  history: 'palette.group.history',
};

export const MODE_HINTS: Record<PaletteKind, MessageKey> = {
  action: 'palette.mode.action',
  connection: 'palette.mode.connection',
  tab: 'palette.mode.tab',
  object: 'palette.mode.object',
  history: 'palette.mode.history',
};

const KIND_ICON: Record<Exclude<PaletteKind, 'object'>, IconName> = {
  action: 'chevronRight',
  connection: 'database',
  tab: 'terminal',
  history: 'history',
};

export function iconOf(item: PaletteItem): IconName {
  return item.kind === 'object' ? KIND_ICONS[item.objectKind] : KIND_ICON[item.kind];
}

/** Whether the object is a relation a `SELECT` can read (the secondary action). */
export function isScriptable(item: PaletteItem): item is ObjectItem {
  return (
    item.kind === 'object' &&
    (item.objectKind === 'table' ||
      item.objectKind === 'view' ||
      item.objectKind === 'materializedView')
  );
}

/** Key of an object: stable across sessions, since the recents are stored by key. */
export function objectKey(
  connectionId: string,
  database: string,
  schema: string | null,
  kind: ObjectKind,
  name: string,
  signature: string | null,
): string {
  return `object:${[connectionId, database, schema ?? '', kind, name, signature ?? ''].join('\u001f')}`;
}
