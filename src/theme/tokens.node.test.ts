// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const THEME_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(THEME_DIR, '..');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function declaredVariables(css: string): Set<string> {
  return new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1] ?? ''));
}

const read = (name: string) => readFileSync(join(THEME_DIR, name), 'utf8');
const tokens = read('tokens.css');
const graphite = read('graphite.css');
const paper = read('paper.css');

describe('themes', () => {
  it('graphite and paper define the same color tokens', () => {
    expect([...declaredVariables(paper)].sort()).toEqual([...declaredVariables(graphite)].sort());
  });

  it.each([
    'env-dev',
    'env-staging',
    'env-prod',
    'cell-modified',
    'cell-inserted',
    'cell-deleted',
    'cell-null',
  ])('defines --%s', (name) => {
    expect(declaredVariables(graphite)).toContain(`--${name}`);
  });
});

describe('component styles', () => {
  const known = new Set([
    ...declaredVariables(tokens),
    ...declaredVariables(graphite),
    ...declaredVariables(paper),
  ]);
  const modules = walk(SRC_DIR)
    .filter((path) => path.endsWith('.module.css'))
    .map((path) => [relative(SRC_DIR, path), readFileSync(path, 'utf8')] as const);

  it('finds the CSS modules', () => {
    expect(modules.length).toBeGreaterThan(0);
  });

  it.each(modules)('%s uses no hard-coded color and only known tokens', (_, css) => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(/i);
    // Component-local variables (e.g. `--tone` set per variant) must be declared in the module.
    const allowed = new Set([...known, ...declaredVariables(css)]);
    for (const match of css.matchAll(/var\((--[\w-]+)/g)) {
      expect(allowed, `unknown token ${match[1] ?? ''}`).toContain(match[1]);
    }
  });
});
