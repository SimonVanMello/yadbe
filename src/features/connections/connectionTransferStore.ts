import { create } from 'zustand';

interface ConnectionTransferStore {
  /** The import dialog (F-012) is open. */
  importing: boolean;
  /** The export dialog is open. */
  exporting: boolean;
  openImport: () => void;
  closeImport: () => void;
  openExport: () => void;
  closeExport: () => void;
}

export const useConnectionTransfer = create<ConnectionTransferStore>()((set) => ({
  importing: false,
  exporting: false,
  openImport: () => {
    set({ importing: true });
  },
  closeImport: () => {
    set({ importing: false });
  },
  openExport: () => {
    set({ exporting: true });
  },
  closeExport: () => {
    set({ exporting: false });
  },
}));
