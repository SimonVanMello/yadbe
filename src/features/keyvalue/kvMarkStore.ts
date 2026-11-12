import { create } from 'zustand';

import type { KvBytes } from '../../ipc';
import { bytesId } from './kvBytes';

/**
 * Keys marked in the explorer (Ctrl / Cmd + click), to delete several at once (M4-6). One set
 * per connection and database; marking in another database starts again.
 */
interface KvMarkStore {
  scope: string | null;
  keys: ReadonlyMap<string, KvBytes>;
}

export const useKvMarkStore = create<KvMarkStore>()(() => ({ scope: null, keys: new Map() }));

function scopeOf(connectionId: string, database: number): string {
  return `${connectionId}\u001f${String(database)}`;
}

export function toggleMark(connectionId: string, database: number, key: KvBytes): void {
  const scope = scopeOf(connectionId, database);
  useKvMarkStore.setState((state) => {
    const keys = new Map(state.scope === scope ? state.keys : []);
    const id = bytesId(key);
    if (keys.has(id)) keys.delete(id);
    else keys.set(id, key);
    return { scope, keys };
  });
}

export function clearMarks(): void {
  useKvMarkStore.setState({ scope: null, keys: new Map() });
}

/** The keys marked in this database. */
export function markedKeys(connectionId: string, database: number): KvBytes[] {
  const state = useKvMarkStore.getState();
  return state.scope === scopeOf(connectionId, database) ? [...state.keys.values()] : [];
}

export function useMarked(connectionId: string, database: number, key: KvBytes): boolean {
  return useKvMarkStore(
    (state) => state.scope === scopeOf(connectionId, database) && state.keys.has(bytesId(key)),
  );
}

export function useMarkCount(connectionId: string, database: number): number {
  return useKvMarkStore((state) =>
    state.scope === scopeOf(connectionId, database) ? state.keys.size : 0,
  );
}
