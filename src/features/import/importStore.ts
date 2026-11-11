import { create } from 'zustand';

import type { ObjectRef } from '../../ipc';

/** What the import wizard opens on: a table of a connection. */
export interface ImportWizardRequest {
  connectionId: string;
  table: ObjectRef;
}

interface ImportStore {
  /** The wizard, `null` when closed. */
  request: ImportWizardRequest | null;
  open: (request: ImportWizardRequest) => void;
  close: () => void;
}

export const useImportStore = create<ImportStore>()((set) => ({
  request: null,
  open: (request) => {
    set({ request });
  },
  close: () => {
    set({ request: null });
  },
}));

/** Opens the import wizard on a table (explorer menu, table tab, palette). */
export function openImport(connectionId: string, table: ObjectRef): void {
  useImportStore.getState().open({ connectionId, table });
}
