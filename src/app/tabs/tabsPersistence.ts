import { editorFromSaved, editorToSaved } from '../../features/query/queryTabPersistence';
import { fileNameOf, type QueryTabState } from '../../features/query/queryTabStore';
import {
  newTableTabState,
  parseTableTabState,
  type TableTabState,
} from '../../features/table-data/tableTabStore';
import type { SavedTab, TabsState } from '../../ipc';
import type { SavedTabs } from './tabsStore';

/** The frontend-owned part of a saved tab (`SavedTab.uiState`). */
function ordinalOf(uiState: string | null): number {
  if (!uiState) return 0;
  try {
    const value: unknown = JSON.parse(uiState);
    if (typeof value === 'object' && value !== null && 'ordinal' in value) {
      const { ordinal } = value;
      if (typeof ordinal === 'number' && Number.isInteger(ordinal) && ordinal > 0) return ordinal;
    }
  } catch {
    // Not ours or corrupted: the tab gets a new number below.
  }
  return 0;
}

function parseUi(uiState: string | null): unknown {
  if (!uiState) return null;
  try {
    return JSON.parse(uiState);
  } catch {
    return null;
  }
}

/** A table tab: its table, and its filter, sort, page size and column layout in `uiState`. */
function tableToBackend(
  tab: SavedTabs['tabs'][number],
  table: NonNullable<SavedTabs['tabs'][number]['table']>,
  view: TableTabState,
): SavedTab {
  return {
    id: tab.id,
    kind: 'table',
    title: table.name,
    connectionId: tab.connectionId,
    database: table.database,
    content: '',
    cursor: null,
    pinned: tab.pinned,
    filePath: null,
    table: { schema: table.schema, name: table.name },
    uiState: JSON.stringify(view),
  };
}

/**
 * The tabs as the backend stores them (F-044). `titleOf` names a query tab in the current
 * language; a welcome tab is an unbound query tab. `editors` holds what each query tab contains
 * (text, cursor, database, file): without it a tab is saved empty. `tables` holds what each
 * table tab shows (filter, sort, page size, columns); its pending changes are never saved.
 */
export function toBackendTabs(
  saved: SavedTabs,
  titleOf: (ordinal: number) => string,
  editors: Readonly<Record<string, QueryTabState>> = {},
  tables: Readonly<Record<string, TableTabState>> = {},
): TabsState {
  return {
    tabs: saved.tabs.map((tab): SavedTab => {
      if (tab.table && tab.connectionId !== null) {
        return tableToBackend(tab, tab.table, tables[tab.id] ?? newTableTabState());
      }
      const editor = tab.connectionId === null ? undefined : editors[tab.id];
      const persisted = editor ? editorToSaved(editor) : null;
      return {
        id: tab.id,
        kind: 'query',
        title:
          tab.connectionId === null
            ? ''
            : editor?.filePath
              ? fileNameOf(editor.filePath)
              : titleOf(tab.ordinal),
        connectionId: tab.connectionId,
        database: persisted?.database ?? null,
        content: persisted?.content ?? '',
        cursor: persisted?.cursor ?? null,
        pinned: tab.pinned,
        filePath: persisted?.filePath ?? null,
        table: null,
        uiState: JSON.stringify({ ordinal: tab.ordinal, ...persisted?.ui }),
      };
    }),
    activeTabId: saved.activeTabId,
  };
}

/** The editor state of every saved query tab (text, cursor, scroll, database, file). */
export function editorsFromBackendTabs(state: TabsState): Record<string, QueryTabState> {
  return Object.fromEntries(
    state.tabs
      .filter((tab) => tab.kind === 'query' && tab.connectionId !== null)
      .map((tab) => [tab.id, editorFromSaved(tab)]),
  );
}

/** What each saved table tab shows (filter, sort, page size, columns). */
export function tablesFromBackendTabs(state: TabsState): Record<string, TableTabState> {
  return Object.fromEntries(
    state.tabs
      .filter((tab) => isRestorableTable(tab))
      .map((tab) => [tab.id, parseTableTabState(parseUi(tab.uiState))]),
  );
}

/** A table tab needs its connection, its database and its table to come back. */
function isRestorableTable(tab: SavedTab): boolean {
  return (
    tab.kind === 'table' && tab.connectionId !== null && tab.table !== null && tab.database !== null
  );
}

/**
 * Reads the tabs the backend returns; a bound tab without a number (saved by something else)
 * gets the next free one. `null` when there is nothing to restore.
 */
export function fromBackendTabs(state: TabsState): SavedTabs | null {
  const kept = state.tabs.filter((tab) => tab.kind === 'query' || isRestorableTable(tab));
  if (kept.length === 0) return null;
  const query = kept.filter((tab) => tab.kind === 'query');
  let next = Math.max(0, ...query.map((tab) => ordinalOf(tab.uiState)));
  return {
    tabs: kept.map((tab) => {
      if (tab.kind === 'table' && tab.table && tab.database !== null) {
        return {
          id: tab.id,
          connectionId: tab.connectionId,
          ordinal: 0,
          pinned: tab.pinned,
          table: { database: tab.database, schema: tab.table.schema, name: tab.table.name },
        };
      }
      const known = ordinalOf(tab.uiState);
      const ordinal = tab.connectionId === null ? 0 : known > 0 ? known : ++next;
      return { id: tab.id, connectionId: tab.connectionId, ordinal, pinned: tab.pinned };
    }),
    activeTabId: state.activeTabId,
  };
}
