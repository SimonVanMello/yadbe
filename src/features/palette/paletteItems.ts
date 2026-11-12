import type { ActionId } from '../../app/actions';
import type { MessageKey } from '../../i18n/i18n';
import type { KvBytes, ObjectKind } from '../../ipc';
import type { IconName } from '../../ui/Icon';
import type { ConnectionState, ConnectionSummary } from '../connections/model';
import { KIND_ICONS } from '../explorer/explorerLabels';
import type { HistoryEntry } from '../history/historyModel';
import type { SavedQuery } from '../../ipc';
import type { Searchable } from './matcher';

export type PaletteKind = 'action' | 'connection' | 'tab' | 'object' | 'history' | 'saved';

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

/**
 * What an object of another engine family is: a MongoDB collection, an Elasticsearch index, data
 * stream or alias, a Redis key. The item opens the object's own tab (never the SQL ones).
 */
export type FamilyObject =
  | { type: 'collection' }
  | { type: 'index' }
  | { type: 'dataStream' }
  | { type: 'alias' }
  | { type: 'key'; database: number; key: KvBytes };

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
  /** Set for an object of the document, search or key-value family; `objectKind` is then unused. */
  family?: FamilyObject;
}

export interface HistoryItem extends Searchable {
  kind: 'history';
  key: string;
  entry: HistoryEntry;
}

/** A saved query or snippet of the library (F-120), searched by name. */
export interface SavedItem extends Searchable {
  kind: 'saved';
  key: string;
  query: SavedQuery;
  /** The folder it is in (`Reports / Monthly`), empty at the root. */
  folder: string;
}

export type PaletteItem =
  ActionItem | ConnectionItem | TabItem | ObjectItem | HistoryItem | SavedItem;

/** Prefixes narrowing the search to one kind (`>` commands, as in VS Code). */
export const MODE_PREFIXES: Record<string, PaletteKind> = {
  '>': 'action',
  ':': 'connection',
  '#': 'tab',
  '@': 'object',
  '!': 'history',
  '*': 'saved',
};

/** The prefix of each kind, for the hint row. */
export const KIND_PREFIX: Record<PaletteKind, string> = {
  action: '>',
  connection: ':',
  tab: '#',
  object: '@',
  history: '!',
  saved: '*',
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
  saved: 'palette.group.saved',
};

export const MODE_HINTS: Record<PaletteKind, MessageKey> = {
  action: 'palette.mode.action',
  connection: 'palette.mode.connection',
  tab: 'palette.mode.tab',
  object: 'palette.mode.object',
  history: 'palette.mode.history',
  saved: 'palette.mode.saved',
};

const KIND_ICON: Record<Exclude<PaletteKind, 'object'>, IconName> = {
  action: 'chevronRight',
  connection: 'database',
  tab: 'terminal',
  history: 'history',
  saved: 'bookmark',
};

const FAMILY_ICONS: Record<FamilyObject['type'], IconName> = {
  collection: 'table',
  index: 'index',
  dataStream: 'layers',
  alias: 'link',
  key: 'key',
};

export function iconOf(item: PaletteItem): IconName {
  if (item.kind !== 'object') return KIND_ICON[item.kind];
  return item.family ? FAMILY_ICONS[item.family.type] : KIND_ICONS[item.objectKind];
}

/** Whether the object is a relation a `SELECT` can read (the secondary action). */
export function isScriptable(item: PaletteItem): item is ObjectItem {
  return (
    item.kind === 'object' &&
    item.family === undefined &&
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
