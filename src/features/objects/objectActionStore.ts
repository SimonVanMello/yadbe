import { create } from 'zustand';

import type { ObjectActionRequest } from '../../ipc';

/** A drop, truncate or rename waiting for its confirmation. */
export interface PendingAction {
  connectionId: string;
  request: ObjectActionRequest;
}

interface ObjectActionStore {
  pending: PendingAction | null;
  open: (pending: PendingAction) => void;
  close: () => void;
}

export const useObjectActionStore = create<ObjectActionStore>()((set) => ({
  pending: null,
  open: (pending) => {
    set({ pending });
  },
  close: () => {
    set({ pending: null });
  },
}));
