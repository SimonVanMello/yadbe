// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const THEME_DIR = dirname(fileURLToPath(import.meta.url));

type Tokens = Record<string, string>;

/** Declarations of the first block whose selector is exactly `selector`. */
function block(css: string, selector: string): Tokens {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return {};
  const end = css.indexOf('}', start);
  const body = css.slice(start + selector.length + 2, end);
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]),
  );
}

function themeTokens(name: string): Tokens {
  const css = readFileSync(join(THEME_DIR, `${name}.css`), 'utf8');
  return block(css, `[data-theme='${name}']`);
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colors. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const SURFACES = [
  '--bg-app',
  '--bg-panel',
  '--bg-elevated',
  '--bg-hover',
  '--bg-selected',
  '--grid-selection-bg',
];
const TEXT = ['--fg-primary', '--fg-secondary', '--fg-muted'];
const STATUS = ['--accent', '--success', '--warning', '--danger', '--info'];
// yadbe tokens (SPEC §7), used as text or markers over the panels.
const DATA = [
  '--env-dev',
  '--env-staging',
  '--env-prod',
  '--cell-modified',
  '--cell-inserted',
  '--cell-deleted',
  '--cell-null',
];
// SQL syntax colors (F-040): read over the editor background and its tinted lines.
const SYNTAX = [
  '--syn-keyword',
  '--syn-string',
  '--syn-tag',
  '--syn-function',
  '--syn-number',
  '--syn-comment',
  '--syn-type',
  '--syn-operator',
  '--syn-special',
];

describe('WCAG AA contrast of the themes', () => {
  for (const name of ['graphite', 'paper']) {
    const t = themeTokens(name);
    const get = (token: string): string => {
      const value = t[token];
      expect(value, `${name}: ${token} is a #rrggbb color`).toMatch(/^#[0-9a-f]{6}$/i);
      return value ?? '#000000';
    };

    it(`${name}: text is at least 4.5:1 on every surface`, () => {
      for (const fg of TEXT) {
        for (const bg of SURFACES) {
          expect(contrast(get(fg), get(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${name}: accent, status, environment and cell-state colors are readable as text`, () => {
      for (const fg of [...STATUS, ...DATA]) {
        for (const bg of ['--bg-app', '--bg-panel']) {
          expect(contrast(get(fg), get(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${name}: SQL syntax colors are at least 4.5:1 on the editor surfaces`, () => {
      for (const fg of SYNTAX) {
        for (const bg of ['--bg-app', '--bg-panel', '--bg-input']) {
          expect(contrast(get(fg), get(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${name}: text on accent and warning fills`, () => {
      expect(contrast(get('--accent-fg'), get('--accent'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(get('--on-warning'), get('--warning'))).toBeGreaterThanOrEqual(4.5);
    });
  }
});
