// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { PALETTES } from './palettes';
import { contrast, ensureContrast, renderThemesCss } from './themeCss';

describe('ensureContrast', () => {
  it('keeps a color that already passes', () => {
    expect(ensureContrast('#ffffff', ['#000000'], 4.5, true)).toBe('#ffffff');
  });

  it('lightens on a dark theme and darkens on a light one, just enough', () => {
    const light = ensureContrast('#6272a4', ['#282a36'], 4.5, true);
    expect(contrast(light, '#282a36')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(light, '#282a36')).toBeLessThan(4.8);
    const dark = ensureContrast('#93a1a1', ['#fdf6e3'], 4.5, false);
    expect(contrast(dark, '#fdf6e3')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('palettes', () => {
  it('have unique ids that fit a data-theme attribute', () => {
    const ids = PALETTES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['graphite', 'paper', 'terminal']) expect(ids).not.toContain(id);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('give 4 syntax colors and 16 ANSI colors', () => {
    for (const p of PALETTES) {
      expect(p.syntax, p.id).toHaveLength(4);
      expect(p.ansi, p.id).toHaveLength(16);
    }
  });
});

// The generator of themes.generated.css: `pnpm themes` rewrites the file, `pnpm check` fails
// when it is stale.
it('themes.generated.css is up to date', async () => {
  await expect(renderThemesCss(PALETTES)).toMatchFileSnapshot('./themes.generated.css');
});
