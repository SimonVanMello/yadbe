import { create } from 'zustand';

import { ipc, unwrap, type StatementLogEntry } from '../../ipc';

/** Statements kept in memory: older ones scroll away, the backend keeps its own bounded record. */
export const LOG_ENTRIES_KEPT = 1000;

export type LogFilter = 'all' | 'errors';

interface LogStore {
  /** Oldest first. */
  entries: StatementLogEntry[];
  filter: LogFilter;
  selectedId: number | null;
  add: (entry: StatementLogEntry) => void;
  replace: (entries: StatementLogEntry[]) => void;
  setFilter: (filter: LogFilter) => void;
  select: (id: number | null) => void;
  /** Empties the view only. */
  clear: () => void;
}

export const useStatementLog = create<LogStore>()((set) => ({
  entries: [],
  filter: 'all',
  selectedId: null,
  add: (entry) => {
    set((state) => {
      // The same statement can arrive from the initial list and from the event.
      if (state.entries.some((existing) => existing.id === entry.id)) return state;
      return { entries: [...state.entries, entry].slice(-LOG_ENTRIES_KEPT) };
    });
  },
  replace: (entries) => {
    set({ entries: entries.slice(-LOG_ENTRIES_KEPT) });
  },
  setFilter: (filter) => {
    set({ filter });
  },
  select: (selectedId) => {
    set({ selectedId });
  },
  clear: () => {
    set({ entries: [], selectedId: null });
  },
}));

export function isFailed(entry: StatementLogEntry): boolean {
  return entry.outcome.kind === 'error';
}

/** Entries to show, newest first. */
export function visibleEntries(
  entries: readonly StatementLogEntry[],
  filter: LogFilter,
): StatementLogEntry[] {
  const kept = filter === 'errors' ? entries.filter(isFailed) : entries;
  return [...kept].reverse();
}

export function failedCount(entries: readonly StatementLogEntry[]): number {
  return entries.filter(isFailed).length;
}

/** Clears the log in the backend, then the view. */
export async function clearStatementLog(): Promise<void> {
  try {
    await unwrap(ipc.commands.clearStatementLog());
  } catch (error) {
    console.warn('Could not clear the statement log', error);
    return;
  }
  useStatementLog.getState().clear();
}

let feed: Promise<void> | undefined;

/** Loads the statements logged so far and follows the new ones; runs once per app launch. */
export function startStatementLogFeed(): Promise<void> {
  feed ??= (async () => {
    ipc.events.subscribe('statementLogged', ({ entry }) => {
      useStatementLog.getState().add(entry);
    });
    try {
      for (const entry of await unwrap(ipc.commands.getStatementLog())) {
        useStatementLog.getState().add(entry);
      }
    } catch (error) {
      console.warn('Statement log unavailable', error);
    }
  })();
  return feed;
}
