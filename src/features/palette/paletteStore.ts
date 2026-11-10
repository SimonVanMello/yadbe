import { create } from 'zustand';

const RECENTS_KEY = 'yadbe.palette.recents';
export const MAX_RECENTS = 8;

function loadRecents(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === 'string').slice(0, MAX_RECENTS)
      : [];
  } catch {
    return [];
  }
}

function saveRecents(recents: readonly string[]): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
  } catch {
    // Recents are a convenience: private mode or a full quota must not break the palette.
  }
}

/** Puts `key` first, without duplicates, capped at `MAX_RECENTS`. */
export function pushRecentKey(recents: readonly string[], key: string): string[] {
  return [key, ...recents.filter((existing) => existing !== key)].slice(0, MAX_RECENTS);
}

interface PaletteStore {
  open: boolean;
  /** What the input holds when the palette opens (`>` for the commands). */
  initialQuery: string;
  /** Item keys (`action:tab.new`, `connection:…`), most recent first. */
  recents: string[];
  /** Opens the palette, or closes it when it is open (the shortcut toggles). */
  toggle: (initialQuery?: string) => void;
  show: (initialQuery?: string) => void;
  hide: () => void;
  remember: (key: string) => void;
}

export const usePaletteStore = create<PaletteStore>()((set) => ({
  open: false,
  initialQuery: '',
  recents: loadRecents(),
  toggle: (initialQuery = '') => {
    set((state) => ({ open: !state.open, initialQuery }));
  },
  show: (initialQuery = '') => {
    set({ open: true, initialQuery });
  },
  hide: () => {
    set({ open: false });
  },
  remember: (key) => {
    set((state) => {
      const recents = pushRecentKey(state.recents, key);
      saveRecents(recents);
      return { recents };
    });
  },
}));
