// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  COLLECTION_METHODS,
  CURSOR_METHODS,
  DATABASE_METHODS,
  GLOBALS,
  REFUSED_METHODS,
} from './mongoshApi';

const prelude = readFileSync(
  new URL('../../../src-tauri/src/session/document/script/prelude.js', import.meta.url),
  'utf8',
).split('\n');

/**
 * The public methods of the object literal that starts at the line holding `opening`: names at
 * four spaces of indent, those starting with `_` left out. `refused` are the ones whose body
 * only throws `notSupported`.
 */
function methodsOf(opening: string): { implemented: string[]; refused: string[] } {
  const start = prelude.findIndex((line) => line.includes(opening));
  expect(start, opening).toBeGreaterThanOrEqual(0);
  const implemented: string[] = [];
  const refused: string[] = [];
  for (let i = start + 1; i < prelude.length; i++) {
    const line = prelude[i] ?? '';
    if (/^ {2}\}\);?$/.test(line) || /^ {2}\};?$/.test(line)) break;
    const method = /^ {4}(?:async )?([A-Za-z]\w*)(?:\(.*\) \{|: )/.exec(line);
    if (!method?.[1]) continue;
    const next = prelude[i + 1] ?? '';
    (/^\s+throw unsupported\(/.test(next) && /\) \{$/.test(line) ? refused : implemented).push(
      method[1],
    );
  }
  return { implemented: implemented.sort(), refused: refused.sort() };
}

describe('the mongosh suggestions follow the runtime', () => {
  it('collection methods', () => {
    const { implemented, refused } = methodsOf('const collectionMethods = {');
    expect([...COLLECTION_METHODS].sort()).toEqual([...implemented].sort());
    expect(refused).toEqual([]);
  });

  it('database methods', () => {
    const { implemented, refused } = methodsOf('const databaseMethods = {');
    expect([...DATABASE_METHODS].sort()).toEqual([...implemented].sort());
    expect([...REFUSED_METHODS.database].sort()).toEqual(refused);
  });

  it('cursor methods, and the ones it refuses', () => {
    const { implemented, refused } = methodsOf('Object.assign(Cursor.prototype, {');
    // `sort`, `limit`… are made by `cursorOption(…)`, listed as `name: cursorOption('name')`.
    expect([...CURSOR_METHODS].sort()).toEqual([...implemented].sort());
    expect([...REFUSED_METHODS.cursor].sort()).toEqual(refused);
  });

  it('globals', () => {
    const start = prelude.findIndex((line) => line.includes('const globals = {'));
    const end = prelude.findIndex((line, i) => i > start && /^ {2}\};$/.test(line));
    const declared = prelude
      .slice(start + 1, end)
      .map((line) => /^ {4}(\w+)(?:,|:)/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
    const suggested = GLOBALS.map((global) => global.name);
    // What the runtime refuses (`rs`, `load`…) or only the engine needs is not suggested.
    const refusedGlobals = [
      'rs',
      'sh',
      'sp',
      'Mongo',
      'connect',
      'load',
      'require',
      'quit',
      'exit',
      'isInteractive',
    ];
    const expected = [...declared.filter((name) => !refusedGlobals.includes(name)), 'db'].sort();
    expect([...suggested].sort()).toEqual(expected);
  });
});
