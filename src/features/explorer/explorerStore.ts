import { create } from 'zustand';

/** Node key of the connection row itself, in its own expanded set. */
export const ROOT_NODE = '["c"]';

interface ExplorerStore {
  /** Expanded nodes per connection (node keys of `explorerRows.ts`), remembered for the session. */
  expanded: Readonly<Record<string, ReadonlySet<string>>>;
  /**
   * Connections opened once: the first time, the tree opens down to the current database
   * (`root`: the connection row is open, `database`: the database too).
   */
  seeded: Readonly<Record<string, 'root' | 'database'>>;
  /** System databases, schemas and objects are hidden by default (F-027). */
  showSystem: boolean;
  setExpanded: (connectionId: string, node: string, expanded: boolean) => void;
  toggle: (connectionId: string, node: string) => void;
  /** Opens the connection row once, the first time it connects. Returns whether it did. */
  seed: (connectionId: string) => boolean;
  /** Opens the current database node once, when the first seed knows its name. */
  seedDatabase: (connectionId: string, databaseNode: string) => void;
  setShowSystem: (show: boolean) => void;
  forget: (connectionId: string) => void;
}

function withNode(
  current: ReadonlySet<string> | undefined,
  node: string,
  expanded: boolean,
): ReadonlySet<string> {
  const next = new Set(current);
  if (expanded) next.add(node);
  else next.delete(node);
  return next;
}

export function createExplorerStore() {
  return create<ExplorerStore>()((set, get) => ({
    expanded: {},
    seeded: {},
    showSystem: false,
    setExpanded: (connectionId, node, expanded) => {
      const current = get().expanded[connectionId];
      if ((current?.has(node) ?? false) === expanded) return;
      set((state) => ({
        expanded: { ...state.expanded, [connectionId]: withNode(current, node, expanded) },
      }));
    },
    toggle: (connectionId, node) => {
      get().setExpanded(connectionId, node, !(get().expanded[connectionId]?.has(node) ?? false));
    },
    seed: (connectionId) => {
      if (get().seeded[connectionId]) return false;
      set((state) => ({
        seeded: { ...state.seeded, [connectionId]: 'root' },
        expanded: {
          ...state.expanded,
          [connectionId]: withNode(state.expanded[connectionId], ROOT_NODE, true),
        },
      }));
      return true;
    },
    seedDatabase: (connectionId, databaseNode) => {
      if (get().seeded[connectionId] !== 'root') return;
      set((state) => ({
        seeded: { ...state.seeded, [connectionId]: 'database' },
        expanded: {
          ...state.expanded,
          [connectionId]: withNode(state.expanded[connectionId], databaseNode, true),
        },
      }));
    },
    setShowSystem: (showSystem) => {
      set({ showSystem });
    },
    forget: (connectionId) => {
      const without = <T>(record: Readonly<Record<string, T>>) =>
        Object.fromEntries(Object.entries(record).filter(([id]) => id !== connectionId));
      set((state) => ({ expanded: without(state.expanded), seeded: without(state.seeded) }));
    },
  }));
}

export const useExplorerStore = createExplorerStore();
