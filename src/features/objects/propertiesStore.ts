import { create } from 'zustand';

import type { ObjectKind, ObjectRef } from '../../ipc';

/** The table or view whose properties are on screen (F-025). */
export interface PropertiesTarget {
  connectionId: string;
  object: ObjectRef;
  kind: ObjectKind;
}

interface PropertiesStore {
  target: PropertiesTarget | null;
  open: (target: PropertiesTarget) => void;
  close: () => void;
}

export const usePropertiesStore = create<PropertiesStore>()((set) => ({
  target: null,
  open: (target) => {
    set({ target });
  },
  close: () => {
    set({ target: null });
  },
}));

/** Opens the properties of a table, view or materialized view. */
export function showProperties(
  connectionId: string,
  object: ObjectRef,
  kind: ObjectKind,
): void {
  usePropertiesStore.getState().open({ connectionId, object, kind });
}
