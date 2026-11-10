import { nativeWindow, type CloseGuard } from '../ipc/nativeWindow';

/**
 * What the window asks before closing, from every feature that could lose something (an open
 * transaction, pending table changes): one guard for the window, asking each in turn.
 */
const guards = new Set<CloseGuard>();

function install(): void {
  if (guards.size === 0) {
    nativeWindow.setCloseGuard(null);
    return;
  }
  nativeWindow.setCloseGuard({
    hasWork: () => [...guards].some((guard) => guard.hasWork()),
    confirm: async () => {
      for (const guard of guards) {
        if (guard.hasWork() && !(await guard.confirm())) return false;
      }
      return true;
    },
  });
}

/** Adds a guard; returns what removes it. */
export function addWindowCloseGuard(guard: CloseGuard): () => void {
  guards.add(guard);
  install();
  return () => {
    guards.delete(guard);
    install();
  };
}
