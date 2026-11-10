import { create } from 'zustand';

import type { ConnectionGroup } from './model';

/** Opens the group dialog: rename `group`, or create a group under `parentId` (`null`: top level). */
export interface GroupDialogRequest {
  group?: ConnectionGroup;
  parentId?: string | null;
}

interface GroupDialogStore {
  request: GroupDialogRequest | null;
  open: (request: GroupDialogRequest) => void;
  close: () => void;
}

export const useGroupDialog = create<GroupDialogStore>()((set) => ({
  request: null,
  open: (request) => {
    set({ request });
  },
  close: () => {
    set({ request: null });
  },
}));
