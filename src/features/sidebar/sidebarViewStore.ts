import { create } from 'zustand';

export type SidebarView = 'connections' | 'history';

interface SidebarViewStore {
  view: SidebarView;
  setView: (view: SidebarView) => void;
}

/** Which view the sidebar shows. */
export const useSidebarView = create<SidebarViewStore>()((set) => ({
  view: 'connections',
  setView: (view) => {
    set({ view });
  },
}));
