import { create } from 'zustand';

/** Entries of a level shown at first, and added by each "show more". */
export const LEVEL_PAGE = 500;

interface KvTreeStore {
  /** The `MATCH` pattern of each database's scan, by connection then database. */
  patterns: Readonly<Record<string, Readonly<Record<number, string>>>>;
  /** Entries shown of each level (node key), by connection; absent: one page. */
  limits: Readonly<Record<string, Readonly<Record<string, number>>>>;
  setPattern: (connectionId: string, database: number, pattern: string) => void;
  showMore: (connectionId: string, node: string) => void;
  forget: (connectionId: string) => void;
}

export const useKvTreeStore = create<KvTreeStore>()((set) => ({
  patterns: {},
  limits: {},
  setPattern: (connectionId, database, pattern) => {
    set((state) => ({
      patterns: {
        ...state.patterns,
        [connectionId]: { ...state.patterns[connectionId], [database]: pattern },
      },
    }));
  },
  showMore: (connectionId, node) => {
    set((state) => {
      const current = state.limits[connectionId]?.[node] ?? LEVEL_PAGE;
      return {
        limits: {
          ...state.limits,
          [connectionId]: { ...state.limits[connectionId], [node]: current + LEVEL_PAGE },
        },
      };
    });
  },
  forget: (connectionId) => {
    const without = <T>(record: Readonly<Record<string, T>>) =>
      Object.fromEntries(Object.entries(record).filter(([id]) => id !== connectionId));
    set((state) => ({ patterns: without(state.patterns), limits: without(state.limits) }));
  },
}));

/** The pattern a database's scan uses (`null`: every key). */
export function patternOf(
  patterns: KvTreeStore['patterns'],
  connectionId: string,
  database: number,
): string | null {
  const pattern = patterns[connectionId]?.[database]?.trim() ?? '';
  return pattern === '' || pattern === '*' ? null : pattern;
}
