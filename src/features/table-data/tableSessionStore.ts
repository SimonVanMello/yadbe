import { create } from 'zustand';

import type {
  EditPreview,
  SortKey,
  StatementFailure,
  TableDataInfo,
  TableRowCount,
  YadbeError,
} from '../../ipc';
import { EMPTY_PENDING, pendingCount, type ChangeTarget, type Pending } from './pendingChanges';

/**
 * What a table tab is doing right now (not saved): the table's description, the page on screen,
 * the counts, the pending changes and the last apply. The rows themselves are in the tab's
 * `TableRowSource` (see `tableSessions.ts`), so a change here never repaints the grid.
 */
export interface TableSession {
  /** `opening`: reading the table's description; `ready`: it is known. */
  phase: 'idle' | 'opening' | 'ready' | 'failed';
  info: TableDataInfo | null;
  /** Why the table could not be opened, or the last page could not be read. */
  error: YadbeError | null;
  /** A page is being read (since when, for the progress shown after 150 ms). */
  loadingSince: number | null;
  /** The raw `WHERE` the engine refused, and what it said. */
  whereError: string | null;
  offset: number;
  page: {
    rowCount: number;
    hasMore: boolean;
    durationMs: number | null;
    order: SortKey[];
  } | null;
  /** Bumped with every page: caches keyed on the rows (cell viewer) start over. */
  pageVersion: number;
  count: TableRowCount | null;
  counting: boolean;
  pending: Pending;
  pendingCount: number;
  /** Bumped with every change of `pending` (cell viewer cache, grid labels). */
  editVersion: number;
  applying: boolean;
  /** The last apply was rolled back because of this statement. */
  failure: { failure: StatementFailure; target: ChangeTarget | null } | null;
  preview: {
    status: 'loading' | 'ready' | 'failed';
    data: EditPreview | null;
    error: YadbeError | null;
  } | null;
  /** Changes were applied to the table from another tab since this page was read. */
  stale: boolean;
}

export function newTableSession(): TableSession {
  return {
    phase: 'idle',
    info: null,
    error: null,
    loadingSince: null,
    whereError: null,
    offset: 0,
    page: null,
    pageVersion: 0,
    count: null,
    counting: false,
    pending: EMPTY_PENDING,
    pendingCount: 0,
    editVersion: 0,
    applying: false,
    failure: null,
    preview: null,
    stale: false,
  };
}

interface TableSessionStore {
  sessions: Record<string, TableSession>;
  patch: (tabId: string, patch: Partial<TableSession>) => void;
  remove: (tabId: string) => void;
}

export const useTableSessionStore = create<TableSessionStore>()((set) => ({
  sessions: {},
  patch: (tabId, patch) => {
    set((state) => {
      const current = state.sessions[tabId] ?? newTableSession();
      const next = { ...current, ...patch };
      if (patch.pending && patch.pending !== current.pending) {
        next.pendingCount = pendingCount(patch.pending);
        next.editVersion = current.editVersion + 1;
      }
      return { sessions: { ...state.sessions, [tabId]: next } };
    });
  },
  remove: (tabId) => {
    set((state) => {
      if (!state.sessions[tabId]) return state;
      return {
        sessions: Object.fromEntries(Object.entries(state.sessions).filter(([id]) => id !== tabId)),
      };
    });
  },
}));

const IDLE = newTableSession();

export function getTableSession(tabId: string): TableSession {
  return useTableSessionStore.getState().sessions[tabId] ?? IDLE;
}

export function useTableSession(tabId: string): TableSession {
  return useTableSessionStore((state) => state.sessions[tabId]) ?? IDLE;
}

/** Pending changes of a tab, for the tab strip, the status bar and the close guards. */
export function usePendingCount(tabId: string): number {
  return useTableSessionStore((state) => state.sessions[tabId]?.pendingCount ?? 0);
}

export interface SelectionSize {
  rows: number;
  cols: number;
}

/** The size of each table grid's selection, for the status bar (kept apart: it changes on every click). */
interface TableSelectionStore {
  sizes: Record<string, SelectionSize | null>;
  report: (tabId: string, size: SelectionSize | null) => void;
}

export const useTableSelectionStore = create<TableSelectionStore>()((set) => ({
  sizes: {},
  report: (tabId, size) => {
    set((state) => ({ sizes: { ...state.sizes, [tabId]: size } }));
  },
}));
