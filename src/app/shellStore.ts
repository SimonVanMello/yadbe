import { create } from 'zustand';

import type { Engine } from '../features/connections/model';
import type { ParsedConnectionString } from '../ipc';

/** Opens the connection dialog: a saved connection to edit, or a new one with a few presets. */
export interface ConnectionDialogRequest {
  /** Saved connection to edit; `null` creates one. */
  connectionId: string | null;
  /** Group a new connection starts in. */
  groupId?: string | null;
  /** Engine a new connection starts with (the first available one by default). */
  engine?: Engine;
  /** Database file a new connection starts with (the file that was just picked). */
  filePath?: string;
  /** Fields a new connection starts with (the command line's URL, without its password). */
  parsed?: ParsedConnectionString;
}

/** App-wide UI state that is not per tab. */
interface ShellStore {
  connectionDialog: ConnectionDialogRequest | null;
  openConnectionDialog: (request: ConnectionDialogRequest) => void;
  closeConnectionDialog: () => void;
  /** The preferences screen (F-125): whether it is open, and the section it opens on. */
  preferences: { section: string | null } | null;
  openPreferences: (section?: string) => void;
  closePreferences: () => void;
}

export const useShellStore = create<ShellStore>()((set) => ({
  connectionDialog: null,
  openConnectionDialog: (connectionDialog) => {
    set({ connectionDialog });
  },
  closeConnectionDialog: () => {
    set({ connectionDialog: null });
  },
  preferences: null,
  openPreferences: (section) => {
    set({ preferences: { section: section ?? null } });
  },
  closePreferences: () => {
    set({ preferences: null });
  },
}));
