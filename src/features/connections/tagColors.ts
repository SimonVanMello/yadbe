/** The user-pickable colors of a custom environment: `--tag-1` … `--tag-9` of the theme. */
export const TAG_COLORS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export type TagColor = (typeof TAG_COLORS)[number];

/**
 * The value of a color token in the current theme, as the `#rrggbb` the backend stores for a
 * custom environment; `null` when the token has no value (no stylesheet loaded).
 */
export function resolveTagColor(color: TagColor): string | null {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(`--tag-${String(color)}`)
    .trim();
  return value === '' ? null : value;
}

/** The color a custom environment starts with. */
export function defaultTagColor(): string | null {
  return resolveTagColor(9);
}
