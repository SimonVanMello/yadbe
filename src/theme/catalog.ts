import { FAMILIES, PALETTES, type ThemeFamily } from './palettes';

export type { ThemeFamily } from './palettes';
export { FAMILIES } from './palettes';

/** A color theme of the catalogue: its id is the `data-theme` value. */
export interface ThemeInfo {
  id: string;
  name: string;
  family: ThemeFamily;
  dark: boolean;
}

export const DEFAULT_LIGHT_THEME = 'paper';
export const DEFAULT_DARK_THEME = 'graphite';

export const THEMES: readonly ThemeInfo[] = [
  { id: 'graphite', name: 'Graphite', family: 'yadbe', dark: true },
  { id: 'paper', name: 'Paper', family: 'yadbe', dark: false },
  { id: 'terminal', name: 'Terminal', family: 'yadbe', dark: true },
  ...PALETTES.map(({ id, name, family, dark }) => ({ id, name, family, dark })),
];

const BY_ID = new Map(THEMES.map((theme) => [theme.id, theme]));

export function themeInfo(id: string): ThemeInfo | undefined {
  return BY_ID.get(id);
}

/**
 * The theme a stored id stands for, in its mode: an unknown id (removed theme, hand edit) or a
 * theme of the other mode falls back to the default of the mode.
 */
export function themeForMode(id: string | null | undefined, dark: boolean): ThemeInfo {
  const theme = id ? BY_ID.get(id) : undefined;
  if (theme && theme.dark === dark) return theme;
  const fallback = BY_ID.get(dark ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME);
  if (!fallback) throw new Error('default themes are in the catalogue');
  return fallback;
}

/** The themes grouped by family, in display order; empty families are left out. */
export function themesByFamily(
  themes: readonly ThemeInfo[] = THEMES,
): { family: ThemeFamily; themes: ThemeInfo[] }[] {
  return FAMILIES.map((family) => ({
    family,
    themes: themes.filter((theme) => theme.family === family),
  })).filter((group) => group.themes.length > 0);
}
