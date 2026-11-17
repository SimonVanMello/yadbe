import { create } from 'zustand';

import {
  mirrorPreferences,
  savePreferences,
  type ThemePreference,
  type ThemeStyle,
} from '../app/preferences';
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, themeForMode, themeInfo } from './catalog';

export type { ThemePreference, ThemeStyle } from '../app/preferences';
/** Id of a theme of the catalogue: the `data-theme` value (`graphite`, `mocha`…). */
export type ThemeName = string;

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** What decides the colors: the mode, the theme of each mode and the interface style. */
export interface ThemeSelection {
  preference: ThemePreference;
  lightTheme: string;
  darkTheme: string;
  style: ThemeStyle;
}

export function isDarkMode(preference: ThemePreference, systemPrefersDark: boolean): boolean {
  return preference === 'system' ? systemPrefersDark : preference === 'dark';
}

/** The theme shown for a selection: the one of the current mode. */
export function resolveTheme(
  selection: Pick<ThemeSelection, 'preference' | 'lightTheme' | 'darkTheme'>,
  systemPrefersDark: boolean,
): ThemeName {
  const dark = isDarkMode(selection.preference, systemPrefersDark);
  return themeForMode(dark ? selection.darkTheme : selection.lightTheme, dark).id;
}

function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

function applyToDocument(theme: ThemeName, style: ThemeStyle): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  if (style === 'terminal') root.dataset.style = 'terminal';
  else delete root.dataset.style;
}

interface ThemeState extends ThemeSelection {
  /** Theme shown for a moment by the theme pickers, not saved; `null` outside a preview. */
  preview: ThemeName | null;
  /** Theme of the selection, preview aside. */
  resolved: ThemeName;
  /** Theme on screen: the preview, else the resolved one. Components redraw on its change. */
  theme: ThemeName;
  setPreference: (preference: ThemePreference) => void;
  setStyle: (style: ThemeStyle) => void;
  /**
   * Makes `id` the theme of its mode and shows it: the mode becomes the theme's, and the OS is
   * followed only while the theme is of the mode the OS is in.
   */
  chooseTheme: (id: ThemeName) => void;
  setPreview: (id: ThemeName | null) => void;
}

const DEFAULT_SELECTION: ThemeSelection = {
  preference: 'system',
  lightTheme: DEFAULT_LIGHT_THEME,
  darkTheme: DEFAULT_DARK_THEME,
  style: 'standard',
};

/** Applies `selection` (and `preview`) to the document; returns the state to store. */
function apply(
  selection: ThemeSelection,
  preview: ThemeName | null,
): Pick<ThemeState, 'resolved' | 'theme'> {
  const resolved = resolveTheme(selection, systemPrefersDark());
  const theme = preview ?? resolved;
  applyToDocument(theme, selection.style);
  return { resolved, theme };
}

function selectionOf(state: ThemeSelection): ThemeSelection {
  const { preference, lightTheme, darkTheme, style } = state;
  return { preference, lightTheme, darkTheme, style };
}

export const useThemeStore = create<ThemeState>()((set, get) => ({
  ...DEFAULT_SELECTION,
  preview: null,
  resolved: DEFAULT_DARK_THEME,
  theme: DEFAULT_DARK_THEME,
  setPreference: (preference) => {
    const selection = { ...selectionOf(get()), preference };
    set({ preference, preview: null, ...apply(selection, null) });
    savePreferences({ theme: preference });
  },
  setStyle: (style) => {
    const selection = { ...selectionOf(get()), style };
    set({ style, ...apply(selection, get().preview) });
    savePreferences({ style });
  },
  chooseTheme: (id) => {
    const info = themeInfo(id);
    if (!info) return;
    const current = selectionOf(get());
    const selection: ThemeSelection = {
      ...current,
      ...(info.dark ? { darkTheme: id } : { lightTheme: id }),
      // A theme of the mode on screen keeps following the OS; one of the other mode would not
      // show at all: it is shown, and the OS is no longer followed.
      preference:
        current.preference === 'system' && info.dark === systemPrefersDark()
          ? 'system'
          : info.dark
            ? 'dark'
            : 'light',
    };
    set({ ...selection, preview: null, ...apply(selection, null) });
    savePreferences({
      theme: selection.preference,
      lightTheme: selection.lightTheme,
      darkTheme: selection.darkTheme,
    });
  },
  setPreview: (id) => {
    const preview = id !== null && themeInfo(id) ? id : null;
    if (preview === get().preview) return;
    set({ preview, ...apply(selectionOf(get()), preview) });
  },
}));

let followingSystem = false;

/** Applies the stored selection and follows OS changes while the preference is `system`. */
export function initTheme(stored: {
  theme: ThemePreference;
  lightTheme: string;
  darkTheme: string;
  style: ThemeStyle;
}): void {
  const selection: ThemeSelection = {
    preference: stored.theme,
    lightTheme: stored.lightTheme,
    darkTheme: stored.darkTheme,
    style: stored.style,
  };
  useThemeStore.setState({ ...selection, preview: null, ...apply(selection, null) });
  mirrorPreferences({
    theme: selection.preference,
    lightTheme: selection.lightTheme,
    darkTheme: selection.darkTheme,
    style: selection.style,
  });
  if (followingSystem) return;
  followingSystem = true;
  window.matchMedia(DARK_QUERY).addEventListener('change', () => {
    const state = useThemeStore.getState();
    if (state.preference !== 'system') return;
    useThemeStore.setState(apply(selectionOf(state), state.preview));
  });
}
