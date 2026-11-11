import { create } from 'zustand';

import type { ExplorerRow } from '../explorer/explorerRows';
import { requestObjectAction } from './objectActions';
import { objectSubject, toolsOfSubject } from './rowTools';

/** The explorer row being renamed in place (F2). */
export interface RenameTarget {
  connectionId: string;
  nodeKey: string;
}

interface RenameStore {
  target: RenameTarget | null;
  start: (target: RenameTarget) => void;
  stop: () => void;
}

export const useRenameStore = create<RenameStore>()((set) => ({
  target: null,
  start: (target) => {
    set({ target });
  },
  stop: () => {
    set({ target: null });
  },
}));

/** Whether a row can be renamed here: an object the engine renames, on a connection that writes. */
export function canRename(row: ExplorerRow): boolean {
  const subject = objectSubject(row);
  if (!subject) return false;
  const tools = toolsOfSubject(subject);
  return tools.rename && !tools.readOnly;
}

/** F2 on a row: its name becomes a field. Returns whether the row can be renamed. */
export function startRename(row: ExplorerRow): boolean {
  if (!canRename(row)) return false;
  useRenameStore.getState().start({ connectionId: row.connectionId, nodeKey: row.nodeKey });
  return true;
}

/** Enter in the field: the confirmation of the rename opens (nothing runs before it). */
export function commitRename(row: ExplorerRow, newName: string): void {
  useRenameStore.getState().stop();
  const subject = objectSubject(row);
  const name = newName.trim();
  if (!subject || name === '' || name === subject.object.name) return;
  requestObjectAction(subject.connectionId, subject.object, subject.kind, subject.id, {
    type: 'rename',
    newName: name,
  });
}
