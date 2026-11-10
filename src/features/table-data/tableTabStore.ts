import { create } from 'zustand';

import type { SortKey } from '../../ipc';
import type { ColumnLayout } from '../grid/DataGrid';
import { EMPTY_FILTER, parseFilterState, type FilterState } from './filterModel';

/**
 * What a table tab shows, saved with the tab (F-080, F-044): its filter, sort, page size and
 * column layout. The table itself is the tab's (`ShellTab.table`); the rows and the pending
 * changes are not saved (a restored tab reads its rows again once connected).
 */
export interface TableTabState {
  filter: FilterState;
  sort: SortKey[];
  pageSize: number;
  layout: ColumnLayout | null;
}

export const PAGE_SIZES = [100, 200, 500, 1000, 5000, 10000] as const;
export const DEFAULT_PAGE_SIZE = 500;

export function newTableTabState(): TableTabState {
  return { filter: EMPTY_FILTER, sort: [], pageSize: DEFAULT_PAGE_SIZE, layout: null };
}

function parseSort(value: unknown): SortKey[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown): SortKey[] => {
    if (typeof item !== 'object' || item === null) return [];
    const column = 'column' in item ? item.column : undefined;
    const direction = 'direction' in item ? item.direction : undefined;
    if (typeof column !== 'string' || (direction !== 'asc' && direction !== 'desc')) return [];
    return [{ column, direction }];
  });
}

function parseLayout(value: unknown): ColumnLayout | null {
  if (typeof value !== 'object' || value === null) return null;
  const widths: Record<string, number> = {};
  const raw = 'widths' in value ? value.widths : undefined;
  if (typeof raw === 'object' && raw !== null) {
    for (const [name, width] of Object.entries(raw)) {
      if (typeof width === 'number' && Number.isFinite(width) && width > 0) widths[name] = width;
    }
  }
  const order =
    'order' in value && Array.isArray(value.order)
      ? value.order.filter((name): name is string => typeof name === 'string')
      : [];
  return { widths, order };
}

/** Reads the state saved in a tab's `uiState`; tolerant to old, partial or foreign data. */
export function parseTableTabState(value: unknown): TableTabState {
  if (typeof value !== 'object' || value === null) return newTableTabState();
  const size = 'pageSize' in value ? value.pageSize : undefined;
  return {
    filter: parseFilterState('filter' in value ? value.filter : undefined),
    sort: parseSort('sort' in value ? value.sort : undefined),
    pageSize:
      typeof size === 'number' && Number.isInteger(size) && size >= 1 && size <= 50_000
        ? size
        : DEFAULT_PAGE_SIZE,
    layout: parseLayout('layout' in value ? value.layout : undefined),
  };
}

interface TableTabStore {
  tabs: Record<string, TableTabState>;
  /** Registers a tab with its saved state, or the defaults. Does nothing when it exists. */
  ensure: (tabId: string, initial?: TableTabState) => void;
  hydrate: (tabs: Record<string, TableTabState>) => void;
  update: (tabId: string, patch: Partial<TableTabState>) => void;
  remove: (tabId: string) => void;
}

export const useTableTabStore = create<TableTabStore>()((set, get) => ({
  tabs: {},
  ensure: (tabId, initial) => {
    if (get().tabs[tabId]) return;
    set((state) => ({ tabs: { ...state.tabs, [tabId]: initial ?? newTableTabState() } }));
  },
  hydrate: (tabs) => {
    set((state) => ({ tabs: { ...state.tabs, ...tabs } }));
  },
  update: (tabId, patch) => {
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: { ...(state.tabs[tabId] ?? newTableTabState()), ...patch } },
    }));
  },
  remove: (tabId) => {
    if (!get().tabs[tabId]) return;
    set((state) => ({
      tabs: Object.fromEntries(Object.entries(state.tabs).filter(([id]) => id !== tabId)),
    }));
  },
}));

export function getTableTabState(tabId: string): TableTabState {
  return useTableTabStore.getState().tabs[tabId] ?? newTableTabState();
}

const DEFAULTS = newTableTabState();

export function useTableTabState(tabId: string): TableTabState {
  return useTableTabStore((state) => state.tabs[tabId]) ?? DEFAULTS;
}
