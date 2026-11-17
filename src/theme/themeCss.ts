import type { ThemePalette } from './palettes';

/*
 * Turns a published palette into the full token set of a theme (the tokens of graphite.css),
 * moving text, accent, status, data and syntax colors just enough to pass the contrast checks
 * of contrast.node.test.ts. The output is themes.generated.css (`pnpm themes`). Same generator
 * as yaggui's, with yadbe's tokens (environments, connection tags, grid cells, SQL editor).
 */

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b]
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colors. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

function toHsl([r, g, b]: Rgb): Rgb {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rn
      ? (gn - bn) / d + (gn < bn ? 6 : 0)
      : max === gn
        ? (bn - rn) / d + 2
        : (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function fromHsl([h, s, l]: Rgb): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number): number => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/** `hex` with its HSL lightness moved by `delta` (−1…1), hue and saturation kept. */
function shiftLightness(hex: string, delta: number): string {
  const [h, s, l] = toHsl(parseHex(hex));
  return toHex(fromHsl([h, s, Math.min(1, Math.max(0, l + delta))]));
}

/**
 * The color closest to `hex` (lighter on a dark theme, darker on a light one) that reaches
 * `min`:1 against every background.
 */
export function ensureContrast(
  hex: string,
  backgrounds: readonly string[],
  min: number,
  dark: boolean,
): string {
  const step = dark ? 0.005 : -0.005;
  const original = hex.toLowerCase();
  // Each candidate starts from the published color: stepping from the rounded previous one
  // would drift the hue.
  for (let i = 0; i < 200; i++) {
    const color = i === 0 ? original : shiftLightness(original, step * i);
    if (backgrounds.every((bg) => contrast(color, bg) >= min)) return color;
  }
  return dark ? '#ffffff' : '#000000';
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgb(${String(r)} ${String(g)} ${String(b)} / ${String(alpha)})`;
}

function mix(a: string, b: string, weightOfB: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const w = weightOfB;
  return toHex([ar + (br - ar) * w, ag + (bg - ag) * w, ab + (bb - ab) * w]);
}

/** The first of `candidates` that reaches 4.5:1 on `fill`, else the best one. */
function readableOn(fill: string, candidates: readonly string[]): string {
  const sorted = [...candidates].sort((a, b) => contrast(b, fill) - contrast(a, fill));
  return candidates.find((c) => contrast(c, fill) >= 4.5) ?? sorted[0] ?? '#000000';
}

export type Tokens = Record<string, string>;

export interface ThemeTokens {
  base: Tokens;
  /** Overrides under `[data-contrast='high']`. */
  high: Tokens;
}

/**
 * Hues of the nine connection tags of graphite.css: blue, cyan, green, lime, yellow, orange,
 * red, pink, violet.
 */
const TAG_HUES = [213, 188, 160, 83, 43, 27, 0, 330, 258];

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * The palette's own colors closest to each tag hue, each used once while there are enough:
 * the tags stay in the theme's tones and tell apart.
 */
export function tagColors(p: ThemePalette): string[] {
  const candidates = [
    ...new Set(
      [...p.lanes, p.success, p.warning, p.danger, p.info, p.accent, ...p.ansi].map((c) =>
        c.toLowerCase(),
      ),
    ),
  ]
    .map((hex) => ({ hex, hsl: toHsl(parseHex(hex)) }))
    // Grays (ANSI black and white, muted lanes) are not hues.
    .filter(({ hsl }) => hsl[1] >= 0.25 && hsl[2] > 0.12 && hsl[2] < 0.9);
  const used = new Set<string>();
  return TAG_HUES.map((target) => {
    const pool = candidates.filter((c) => !used.has(c.hex));
    const ranked = (pool.length > 0 ? pool : candidates).sort(
      (a, b) => hueDistance(a.hsl[0] * 360, target) - hueDistance(b.hsl[0] * 360, target),
    );
    const best = ranked[0]?.hex ?? p.accent;
    used.add(best);
    return best;
  });
}

/** Indexes of the 16 ANSI colors (normal then bright). */
const ANSI = { yellow: 3, magenta: 5, cyan: 6 } as const;
const BRIGHT = 8;

export function themeTokens(p: ThemePalette): ThemeTokens {
  const { dark } = p;
  const ansi = (index: number): string => p.ansi[index] ?? p.fg;
  // The grid selection is opaque (F-063): an accent tint baked into the background, so that
  // every text color can be checked against it.
  const gridSelection = mix(p.bg, p.accent, dark ? 0.14 : 0.08);
  const gridSelectionHeader = mix(p.bg, p.accent, dark ? 0.2 : 0.14);
  const surfaces = [p.bg, p.panel, p.elevated, p.hover, p.selected, gridSelection];
  const text = (hex: string, min: number) => ensureContrast(hex, surfaces, min, dark);
  const status = (hex: string) => ensureContrast(hex, [p.bg, p.panel], 4.5, dark);
  const syntax = (hex: string) => ensureContrast(hex, [p.bg, p.panel, p.input], 4.5, dark);
  const tags = tagColors(p).map((hex) => ensureContrast(hex, [p.bg, p.panel], 3, dark));

  const accent = status(p.accent);
  let warning = status(p.warning);
  let onWarning = readableOn(warning, ['#000000', '#ffffff']);
  // A dark warning on a light theme can sit between black and white text: darken it a bit more.
  const published = warning;
  for (let i = 1; contrast(onWarning, warning) < 4.5 && i <= 40; i++) {
    warning = shiftLightness(published, (dark ? 0.01 : -0.01) * i);
    onWarning = readableOn(warning, ['#000000', '#ffffff']);
  }
  const success = status(p.success);
  const danger = status(p.danger);
  const fg3 = text(p.fg3, 4.5);
  const soft = dark ? 0.14 : 0.1;

  const base: Tokens = {
    '--bg-app': p.bg,
    '--bg-panel': p.panel,
    '--bg-elevated': p.elevated,
    '--bg-hover': p.hover,
    '--bg-active': mix(p.hover, p.selected, 0.5),
    '--bg-selected': p.selected,
    '--bg-input': p.input,
    '--bg-titlebar': p.titlebar,
    '--bg-scrim': dark ? 'rgb(0 0 0 / 0.35)' : 'rgb(30 35 45 / 0.18)',
    '--fg-primary': text(p.fg, 4.5),
    '--fg-secondary': text(p.fg2, 4.5),
    '--fg-muted': fg3,
    '--border-subtle': p.border,
    '--border-strong': p.borderStrong,
    '--bg-disabled': mix(p.bg, p.fg, 0.06),
    '--fg-disabled': mix(fg3, p.bg, 0.45),
    '--accent': accent,
    '--accent-hover': shiftLightness(accent, dark ? 0.06 : -0.06),
    '--accent-fg': readableOn(accent, [p.bg, '#ffffff', '#000000']),
    '--accent-soft': rgba(accent, dark ? 0.16 : 0.1),
    '--success': success,
    '--warning': warning,
    '--danger': danger,
    '--danger-soft': rgba(danger, dark ? 0.14 : 0.08),
    '--info': status(p.info),
    '--on-warning': onWarning,
    '--env-dev': success,
    '--env-staging': warning,
    '--env-prod': danger,
    '--env-dev-soft': rgba(success, soft),
    '--env-staging-soft': rgba(warning, soft),
    '--env-prod-soft': rgba(danger, soft),
    ...Object.fromEntries(tags.map((hex, i) => [`--tag-${String(i + 1)}`, hex])),
    '--cell-modified': warning,
    '--cell-inserted': success,
    '--cell-deleted': danger,
    '--cell-null': fg3,
    '--cell-modified-bg': rgba(warning, soft),
    '--cell-inserted-bg': rgba(success, soft),
    '--cell-deleted-bg': rgba(danger, soft),
    '--grid-selection-bg': gridSelection,
    '--grid-selection-header-bg': gridSelectionHeader,
    '--syn-keyword': syntax(p.syntax[0]),
    '--syn-string': syntax(p.syntax[1]),
    '--syn-tag': syntax(p.syntax[2]),
    '--syn-function': syntax(p.syntax[3]),
    '--syn-number': syntax(ansi(BRIGHT + ANSI.yellow)),
    '--syn-comment': syntax(p.fg3),
    '--syn-type': syntax(ansi(ANSI.cyan)),
    '--syn-operator': syntax(p.fg2),
    '--syn-special': syntax(ansi(BRIGHT + ANSI.magenta)),
    '--editor-selection': rgba(accent, dark ? 0.3 : 0.22),
    '--editor-active-line': dark ? 'rgb(255 255 255 / 0.035)' : 'rgb(0 0 0 / 0.035)',
    '--editor-statement': rgba(accent, dark ? 0.14 : 0.09),
    '--editor-bracket-match': rgba(accent, dark ? 0.32 : 0.22),
    '--editor-search-match': rgba(warning, dark ? 0.3 : 0.25),
    '--shadow-popover': dark ? '0 12px 40px rgb(0 0 0 / 0.5)' : '0 12px 32px rgb(15 23 42 / 0.14)',
  };
  const high: Tokens = {
    '--fg-primary': text(p.fg, 7),
    '--fg-secondary': text(p.fg2, 7),
    '--fg-muted': text(p.fg3, 7),
    '--border-subtle': ensureContrast(p.border, [p.bg, p.panel], 3, dark),
    '--border-strong': ensureContrast(p.borderStrong, [p.bg, p.panel], 3.6, dark),
  };
  return { base, high };
}

function block(selector: string, tokens: Tokens, colorScheme?: string): string {
  const lines = Object.entries(tokens).map(([name, value]) => `  ${name}: ${value};`);
  if (colorScheme) lines.unshift(`  color-scheme: ${colorScheme};`);
  return `${selector} {\n${lines.join('\n')}\n}\n`;
}

/** The CSS of every palette: one block per theme, then its high contrast overrides. */
export function renderThemesCss(palettes: readonly ThemePalette[]): string {
  const header =
    '/* Generated by `pnpm themes` from src/theme/palettes.ts (src/theme/themeCss.ts). Do not edit. */\n';
  return (
    header +
    palettes
      .map((p) => {
        const { base, high } = themeTokens(p);
        return (
          `\n/* ${p.name} */\n` +
          block(`[data-theme='${p.id}']`, base, p.dark ? 'dark' : 'light') +
          '\n' +
          block(`[data-theme='${p.id}'][data-contrast='high']`, high)
        );
      })
      .join('')
  );
}
